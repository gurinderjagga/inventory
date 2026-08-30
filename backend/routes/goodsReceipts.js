const express = require('express');
const { query, runTransaction } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../lib/errors');
const v = require('../lib/validate');
const money = require('../lib/money');
const { applyMovement } = require('../lib/stockLedger');

const router = express.Router();
router.use(authMiddleware);

/**
 * Normalise and validate the line items of an incoming receipt.
 *
 * Same shape as invoices.js's normalizeLines — company_id scoping stops one
 * company's delivery from crediting another company's stock, and the stored
 * item name (not whatever the client sent) is what gets snapshotted.
 */
async function normalizeLines(companyId, line_items) {
  if (!Array.isArray(line_items) || line_items.length === 0) {
    throw new ValidationError('At least one line item is required');
  }

  const lines = line_items.map((li, idx) => {
    const label = `Line ${idx + 1}`;
    const qty   = v.nonNegativeNumber(li.quantity, `${label} quantity`);
    if (qty <= 0) throw new ValidationError(`${label} quantity must be greater than 0`);
    return {
      itemId:   v.id(li.item_id, `${label} item_id`),
      quantity: qty,
      unitCost: v.nonNegativeNumber(li.unit_cost, `${label} unit cost`, { fallback: 0 }),
    };
  });

  const ids = [...new Set(lines.map(l => l.itemId))];
  const { rows: found } = await query(
    'SELECT id, name FROM items WHERE id = ANY($1::int[]) AND company_id = $2',
    [ids, companyId]
  );
  const nameById = new Map(found.map(r => [r.id, r.name]));
  const missing  = ids.filter(id => !nameById.has(id));
  if (missing.length) {
    throw new ValidationError(
      `No such item${missing.length === 1 ? '' : 's'} for this company: ${missing.join(', ')}`
    );
  }

  return lines.map(l => ({ ...l, itemName: nameById.get(l.itemId) }));
}

// GET /api/goods-receipts/company/:companyId
router.get('/company/:companyId', asyncHandler(async (req, res) => {
  const companyId = v.id(req.params.companyId, 'Company id');
  const { rows } = await query(
    'SELECT * FROM goods_receipts WHERE company_id = $1 ORDER BY received_date DESC, id DESC',
    [companyId]
  );
  res.json(rows);
}));

// GET /api/goods-receipts/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Goods receipt id');
  const { rows } = await query('SELECT * FROM goods_receipts WHERE id = $1', [id]);
  const receipt = rows[0];
  if (!receipt) throw new NotFoundError('Goods receipt not found');

  const lines = await query(
    'SELECT * FROM goods_receipt_line_items WHERE goods_receipt_id = $1 ORDER BY id',
    [id]
  );
  receipt.line_items = lines.rows;
  res.json(receipt);
}));

// POST /api/goods-receipts  — record stock arriving, atomically
//
// No draft/finalize distinction, no customer, no tax: a receipt just records
// what arrived. Immutable once created — there is no PUT or DELETE here; a
// mistaken receipt is corrected with a manual stock adjustment (POST
// /api/items/:id/adjust) and a note explaining why, the same as a mistaken
// physical count.
router.post('/', asyncHandler(async (req, res) => {
  const { company_id, supplier_name, received_date, notes, line_items } = req.body;

  const companyId = v.id(company_id, 'company_id');
  const supplier  = v.requiredString(supplier_name, 'Supplier name');

  const { rows: company } = await query('SELECT id FROM companies WHERE id = $1', [companyId]);
  if (!company[0]) throw new NotFoundError('Company not found');

  const lines = await normalizeLines(companyId, line_items);

  const receipt = await runTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO goods_receipts (company_id, supplier_name, received_date, notes)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4)
       RETURNING *`,
      [companyId, supplier, received_date || null, v.optionalString(notes)]
    );
    const created = rows[0];

    for (const line of lines) {
      await client.query(
        `INSERT INTO goods_receipt_line_items (goods_receipt_id, item_id, item_name, quantity, unit_cost)
         VALUES ($1, $2, $3, $4, $5)`,
        [created.id, line.itemId, line.itemName, money.quantity(line.quantity), money.money(line.unitCost)]
      );
      await applyMovement(client, {
        itemId: line.itemId, companyId, delta: line.quantity,
        reason: 'goods_received', goodsReceiptId: created.id, userId: req.user.id,
      });
    }

    return created;
  });

  res.status(201).json(receipt);
}));

module.exports = router;
