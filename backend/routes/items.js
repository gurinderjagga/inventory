const express = require('express');
const { query, runTransaction, PG_UNIQUE_VIOLATION } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { requireCompanyAccess } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/asyncHandler');
const { NotFoundError, ConflictError } = require('../lib/errors');
const { sendCached } = require('../lib/httpCache');
const v = require('../lib/validate');
const money = require('../lib/money');
const { applyMovement } = require('../lib/stockLedger');
const { recomputeCompanyAggregates } = require('../lib/companyAggregates');

const router = express.Router();
router.use(authMiddleware);

/** Resolve the company an existing item belongs to, for requireCompanyAccess. */
async function companyIdForItem(req) {
  const { rows } = await query('SELECT company_id FROM items WHERE id = $1', [v.id(req.params.id, 'Item id')]);
  return rows[0]?.company_id;
}

/**
 * Read and validate the item payload shared by POST and PUT, so both enforce
 * the same rules.
 *
 * Defaults apply only when a field is genuinely absent: an explicit 0 is kept,
 * and unparseable input is rejected rather than silently defaulted.
 *
 * `quantity` is deliberately NOT read here — editing an item no longer
 * touches stock at all (see POST for the one-time starting quantity, and
 * POST /:id/adjust for every change after that). Every quantity change has to
 * go through lib/stockLedger.js so it is attributed and reasoned; a bare
 * field on this form would be a silent, unlogged back door around that.
 */
function readBody(body) {
  // Validated as numbers, then normalised to the column's scale as strings.
  // Postgres would round to scale on its own, but doing it here means the value
  // written is the value this code decided on, under the rounding policy in
  // lib/money.js — not whatever the database happened to do with it.
  return {
    name:       v.requiredString(body.name, 'Item name'),
    sku:        v.optionalString(body.sku),
    unit:       v.optionalString(body.unit) || 'pcs',
    unitPrice:  money.money(v.nonNegativeNumber(body.unit_price, 'Unit price', { fallback: 0 })),
    threshold:  money.quantity(v.nonNegativeNumber(body.low_stock_threshold, 'Low stock threshold', { fallback: 10 })),
    hsnSacCode: v.optionalString(body.hsn_sac_code),
    isService:  v.boolean(body.is_service),
    gstRate:    v.nonNegativeNumber(body.gst_rate, 'GST rate', { fallback: 0 }),
    uqc:        v.optionalString(body.uqc),
    costPrice:  money.money(v.nonNegativeNumber(body.cost_price, 'Cost price', { fallback: 0 })),
  };
}

/** Read the archive/active flag on PUT, preserving the current value when omitted. */
function readActive(body, current) {
  return body.active === undefined ? current : v.boolean(body.active, { fallback: current });
}

// GET /api/items/company/:companyId  — items scoped to a company, paginated
// like every other list endpoint (stock movements, invoices) — an
// unbounded catalog was the one list left that could grow without limit.
router.get('/company/:companyId', requireCompanyAccess(req => req.params.companyId), asyncHandler(async (req, res) => {
  const companyId = v.id(req.params.companyId, 'Company id');
  const page      = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit     = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const offset    = (page - 1) * limit;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    // Narrowed to the columns the list view (and the edit form it feeds,
    // which needs everything a create does except the audit fields) actually
    // reads — company_id, created_at, and updated_at are never used once the
    // row reaches the frontend, same over-fetch pattern already fixed on the
    // other two paginated list queries (stock.js, invoices.js).
    query(
      `SELECT id, name, sku, unit, quantity, unit_price, low_stock_threshold,
              hsn_sac_code, is_service, gst_rate, uqc, cost_price, active
       FROM items WHERE company_id = $1 ORDER BY name ASC LIMIT $2 OFFSET $3`,
      [companyId, limit, offset]
    ),
    query('SELECT COUNT(*)::int AS total FROM items WHERE company_id = $1', [companyId]),
  ]);

  sendCached(req, res, {
    items: rows, total: countRows[0].total, page, limit,
    pages: Math.ceil(countRows[0].total / limit),
  });
}));

// GET /api/items/:id
router.get('/:id', requireCompanyAccess(companyIdForItem), asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Item id');
  const { rows } = await query('SELECT * FROM items WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Item not found');
  res.json(rows[0]);
}));

// POST /api/items
router.post('/', requireCompanyAccess(req => req.body.company_id), asyncHandler(async (req, res) => {
  const companyId       = v.id(req.body.company_id, 'company_id');
  const item            = readBody(req.body);
  const startingQuantity = money.quantity(v.nonNegativeNumber(req.body.quantity, 'Quantity', { fallback: 0 }));

  // Check the parent exists so a bad company_id reads as a bad request rather
  // than a foreign-key failure.
  const { rows: company } = await query('SELECT id FROM companies WHERE id = $1', [companyId]);
  if (!company[0]) throw new NotFoundError('Company not found');

  try {
    const created = await runTransaction(async (client) => {
      // Inserted at zero and brought up through the ledger below, rather than
      // written directly — so a starting quantity gets the same
      // `initial_stock` movement an item created empty and stocked later
      // would, and the invariant "quantity == sum of this item's movements"
      // holds from the very first row.
      const { rows } = await client.query(
        `INSERT INTO items
           (company_id, name, sku, unit, quantity, unit_price, low_stock_threshold,
            hsn_sac_code, is_service, gst_rate, uqc, cost_price)
         VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [companyId, item.name, item.sku, item.unit, item.unitPrice, item.threshold,
          item.hsnSacCode, item.isService, item.gstRate, item.uqc, item.costPrice]
      );
      const row = rows[0];
      if (!money.dec(startingQuantity).isZero()) {
        // Re-read rather than patch row.quantity by hand: applyMovement
        // writes through the `pg` driver's own NUMERIC parser, and a manual
        // string assignment here would hand the client "25.000" where every
        // other response gives it the number 25.
        const newQuantity = await applyMovement(client, {
          itemId: row.id, companyId, delta: startingQuantity,
          reason: 'initial_stock', userId: req.user.id,
        });
        row.quantity = newQuantity;
      } else {
        // applyMovement recomputes the company's aggregates itself as a side
        // effect of the quantity it just changed — but an item created with
        // no starting quantity never calls it, and item_count still needs to
        // account for the new row.
        await recomputeCompanyAggregates(client, companyId);
      }
      return row;
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw new ConflictError('An item with that SKU already exists for this company');
    }
    throw err;
  }
}));

// PUT /api/items/:id — everything about an item except its stock. Quantity
// changes only through POST /:id/adjust (or a document that moves stock),
// never a bare overwrite here — see readBody().
router.put('/:id', requireCompanyAccess(companyIdForItem), asyncHandler(async (req, res) => {
  const id   = v.id(req.params.id, 'Item id');
  const item = readBody(req.body);

  const { rows: existing } = await query('SELECT active FROM items WHERE id = $1', [id]);
  if (!existing[0]) throw new NotFoundError('Item not found');
  const active = readActive(req.body, existing[0].active);

  try {
    const updated = await runTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE items
         SET name = $1, sku = $2, unit = $3, unit_price = $4, low_stock_threshold = $5,
             hsn_sac_code = $6, is_service = $7, gst_rate = $8, uqc = $9, cost_price = $10,
             active = $11, updated_at = now()
         WHERE id = $12
         RETURNING *`,
        [item.name, item.sku, item.unit, item.unitPrice, item.threshold,
          item.hsnSacCode, item.isService, item.gstRate, item.uqc, item.costPrice, active, id]
      );
      if (!rows[0]) throw new NotFoundError('Item not found');
      // Price and threshold can both change here without quantity moving at
      // all — either one changes this item's contribution to stock_value or
      // low_stock_count, so the company's aggregates need a recompute same
      // as any quantity-driven change does.
      await recomputeCompanyAggregates(client, rows[0].company_id);
      return rows[0];
    });
    res.json(updated);
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw new ConflictError('An item with that SKU already exists for this company');
    }
    throw err;
  }
}));

// Stock quantity corrections now go through POST /api/stock/movements
// (mode: 'count') — see routes/stock.js — so every quantity change, in/out/
// correction alike, funnels through one endpoint with one lock strategy.

// GET /api/items/:id/movements — the ledger for one item, newest first.
// Capped rather than fully paginated: this feeds a history drill-down modal
// with no page controls, so the fix for "unbounded and append-only forever"
// is a sane limit, not a pagination UI this view doesn't have.
router.get('/:id/movements', requireCompanyAccess(companyIdForItem), asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Item id');
  const { rows } = await query(
    `SELECT m.*, u.username, inv.invoice_no
     FROM stock_movements m
     LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN invoices inv ON inv.id = m.invoice_id
     WHERE m.item_id = $1
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 200`,
    [id]
  );
  res.json(rows);
}));

// DELETE /api/items/:id
router.delete('/:id', requireCompanyAccess(companyIdForItem), asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Item id');

  const { rows: existing } = await query('SELECT name, company_id FROM items WHERE id = $1', [id]);
  if (!existing[0]) throw new NotFoundError('Item not found');

  // An item that appears on an invoice or a goods receipt cannot be removed
  // without rewriting that document's history, so report the conflict rather
  // than failing opaquely. A solo movement (initial stock, a manual
  // adjustment) has no such document depending on it and cascades away with
  // the item — see stock_movements.item_id ON DELETE CASCADE.
  const { rows: invoiceRefs } = await query(
    `SELECT COUNT(DISTINCT invoice_id)::int AS count
     FROM invoice_line_items
     WHERE item_id = $1`,
    [id]
  );
  if (invoiceRefs[0].count > 0) {
    const n = invoiceRefs[0].count;
    throw new ConflictError(
      `Cannot delete "${existing[0].name}" — it appears on ${n} invoice${n === 1 ? '' : 's'}. ` +
      `Archive it instead to take it out of circulation.`
    );
  }

  await runTransaction(async (client) => {
    await client.query('DELETE FROM items WHERE id = $1', [id]);
    // The deleted item's own count/value must drop out of the company's
    // totals too — a recompute over what's left, same as every other
    // aggregate-affecting mutation in this file.
    await recomputeCompanyAggregates(client, existing[0].company_id);
  });
  res.json({ message: 'Item deleted successfully' });
}));

module.exports = router;
