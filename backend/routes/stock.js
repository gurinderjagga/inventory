/**
 * routes/stock.js
 *
 *   POST /api/stock/movements   — the one way to change an item's quantity
 *                                 by hand: receive, dispatch, or correct a count
 *   GET  /api/stock/movements   — paginated movement history for a company
 *
 * A GST invoice is a different kind of document (numbered, legally filed) and
 * moves stock through routes/invoices.js finalize/reverse instead — see the
 * comment on MODES below for how the two relate.
 */
const express = require('express');
const { query, runTransaction } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { requireCompanyAccess } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/asyncHandler');
const { NotFoundError, ValidationError } = require('../lib/errors');
const v = require('../lib/validate');
const money = require('../lib/money');
const { applyMovement } = require('../lib/stockLedger');
const { encodeCursor, decodeCursor } = require('../lib/keysetCursor');

const router = express.Router();
router.use(authMiddleware);

// mode -> stock_movements.reason, and whether `quantity` is a delta (how much
// moved) or an absolute target (what the shelf actually holds).
const MODES = {
  in:    { reason: 'stock_in',          absolute: false },
  out:   { reason: 'stock_out',         absolute: false },
  count: { reason: 'manual_adjustment', absolute: true  },
};

// ── POST /api/stock/movements ────────────────────────────────────────────────
router.post('/movements', requireCompanyAccess(req => req.body.company_id), asyncHandler(async (req, res) => {
  const companyId = v.id(req.body.company_id, 'company_id');
  const itemId    = v.id(req.body.item_id, 'item_id');
  const mode      = MODES[req.body.mode];
  if (!mode) throw new ValidationError('mode must be "in", "out", or "count"');

  const note        = v.optionalString(req.body.note);
  const referenceNo = v.optionalString(req.body.reference_no);
  // In/out are real movements of physical goods — a supplier bill, a job
  // slip, a customer's own challan — that reference is what makes the ledger
  // searchable later, so it isn't optional the way a passing note is. A count
  // correction has no such document; it's `note` that carries the reason
  // there (validated below), not a reference.
  if (!mode.absolute && !referenceNo) {
    throw new ValidationError('Reference number is required for stock in/out');
  }
  if (mode.absolute && !note) {
    throw new ValidationError('A note explaining the correction is required');
  }

  const quantity = money.quantity(v.nonNegativeNumber(req.body.quantity, 'Quantity'));
  if (!mode.absolute && money.dec(quantity).isZero()) {
    throw new ValidationError('Quantity must be greater than zero');
  }

  const result = await runTransaction(async (client) => {
    // Locked here (not left to applyMovement's own atomic UPDATE) because
    // count mode needs to read the current quantity before it can compute a
    // delta — the lock has to cover that read-then-decide, not just the
    // write. Applied uniformly to in/out too, both for one code path and
    // because it also re-confirms the item actually belongs to this
    // company (requireCompanyAccess only checked the caller can reach
    // company_id, not that item_id is really one of its items).
    const { rows } = await client.query(
      'SELECT quantity FROM items WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [itemId, companyId]
    );
    if (!rows[0]) throw new NotFoundError('Item not found for this company');

    const delta = mode.absolute
      ? money.dec(quantity).minus(money.dec(rows[0].quantity))
      : req.body.mode === 'out' ? money.dec(quantity).negated() : money.dec(quantity);

    await applyMovement(client, {
      itemId, companyId, delta,
      reason: mode.reason,
      note, referenceNo,
      userId: req.user.id,
    });

    const { rows: after } = await client.query('SELECT quantity FROM items WHERE id = $1', [itemId]);
    return { newQuantity: after[0].quantity, delta: delta.toString() };
  });

  res.status(201).json({
    item_id:        itemId,
    mode:           req.body.mode,
    quantity_delta: Number(result.delta),
    new_quantity:   result.newQuantity,
  });
}));

// ── GET /api/stock/movements ─────────────────────────────────────────────────
// Movement history for a company, newest first — keyset (seek) pagination,
// not OFFSET: stock_movements is append-only, so a fixed "page 50" would get
// slower every month on its own as the ledger grows, purely from Postgres
// having to walk and discard every row ahead of an OFFSET window. A cursor
// (opaque; see lib/keysetCursor.js) instead names exactly where the last
// page ended, so the next one is an index seek — cost proportional to page
// size, not to how deep into history the page is.
//
// Query params: company_id (required), cursor (optional — omit for the first
// page), limit (default 50)
router.get('/movements', requireCompanyAccess(req => req.query.company_id), asyncHandler(async (req, res) => {
  const companyId = v.id(req.query.company_id, 'company_id');
  const limit      = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

  let cursor;
  try {
    cursor = decodeCursor(req.query.cursor);
  } catch {
    throw new ValidationError('Invalid pagination cursor');
  }

  // The page of rows and the total count don't depend on each other — run
  // them concurrently rather than paying two sequential round trips. `total`
  // is only for the "Page X of Y" display; the data query itself no longer
  // needs it.
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(`
      SELECT
        m.id,
        m.reason,
        m.quantity_delta,
        m.note,
        m.reference_no,
        m.created_at,
        to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_precise,
        i.id          AS item_id,
        i.name        AS item_name,
        i.unit        AS item_unit,
        u.username    AS performed_by
      FROM stock_movements m
      JOIN items i ON i.id = m.item_id
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.company_id = $1
        AND ($3::timestamptz IS NULL OR (m.created_at, m.id) < ($3::timestamptz, $4::int))
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2
    `, [companyId, limit, cursor?.createdAt ?? null, cursor?.id ?? null]),
    query('SELECT COUNT(*)::int AS total FROM stock_movements WHERE company_id = $1', [companyId]),
  ]);

  const last = rows[rows.length - 1];
  const nextCursor = rows.length === limit && last
    ? encodeCursor({ createdAt: last.created_at_precise, id: last.id })
    : null;
  rows.forEach(r => delete r.created_at_precise);

  res.json({
    movements: rows,
    total:      countRows[0].total,
    limit,
    pages:      Math.ceil(countRows[0].total / limit),
    nextCursor,
  });
}));

module.exports = router;
