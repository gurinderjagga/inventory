const express = require('express');
const { query } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { NotFoundError, ConflictError } = require('../lib/errors');
const v = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);

/**
 * Read and validate the item payload shared by POST and PUT, so both enforce
 * the same rules.
 *
 * Defaults apply only when a field is genuinely absent: an explicit 0 is kept,
 * and unparseable input is rejected rather than silently defaulted.
 */
function readBody(body) {
  return {
    name:       v.requiredString(body.name, 'Item name'),
    sku:        v.optionalString(body.sku),
    unit:       v.optionalString(body.unit) || 'pcs',
    quantity:   v.nonNegativeNumber(body.quantity,   'Quantity',   { fallback: 0 }),
    unitPrice:  v.nonNegativeNumber(body.unit_price, 'Unit price', { fallback: 0 }),
    threshold:  v.nonNegativeNumber(body.low_stock_threshold, 'Low stock threshold', { fallback: 10 }),
  };
}

// GET /api/items/company/:companyId  — items scoped to a company
router.get('/company/:companyId', asyncHandler(async (req, res) => {
  const companyId = v.id(req.params.companyId, 'Company id');
  const { rows } = await query(
    'SELECT * FROM items WHERE company_id = $1 ORDER BY name ASC',
    [companyId]
  );
  res.json(rows);
}));

// GET /api/items/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Item id');
  const { rows } = await query('SELECT * FROM items WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Item not found');
  res.json(rows[0]);
}));

// POST /api/items
router.post('/', asyncHandler(async (req, res) => {
  const companyId = v.id(req.body.company_id, 'company_id');
  const item      = readBody(req.body);

  // Check the parent exists so a bad company_id reads as a bad request rather
  // than a foreign-key failure.
  const { rows: company } = await query('SELECT id FROM companies WHERE id = $1', [companyId]);
  if (!company[0]) throw new NotFoundError('Company not found');

  const { rows } = await query(
    `INSERT INTO items (company_id, name, sku, unit, quantity, unit_price, low_stock_threshold)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [companyId, item.name, item.sku, item.unit, item.quantity, item.unitPrice, item.threshold]
  );
  res.status(201).json(rows[0]);
}));

// PUT /api/items/:id
router.put('/:id', asyncHandler(async (req, res) => {
  const id   = v.id(req.params.id, 'Item id');
  const item = readBody(req.body);

  const { rows } = await query(
    `UPDATE items
     SET name = $1, sku = $2, unit = $3, quantity = $4, unit_price = $5, low_stock_threshold = $6
     WHERE id = $7
     RETURNING *`,
    [item.name, item.sku, item.unit, item.quantity, item.unitPrice, item.threshold, id]
  );
  if (!rows[0]) throw new NotFoundError('Item not found');
  res.json(rows[0]);
}));

// DELETE /api/items/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Item id');

  const { rows: existing } = await query('SELECT name FROM items WHERE id = $1', [id]);
  if (!existing[0]) throw new NotFoundError('Item not found');

  // An item that appears on an invoice cannot be removed without rewriting
  // that invoice's history, so report the conflict rather than failing opaquely.
  const { rows: refs } = await query(
    `SELECT COUNT(DISTINCT invoice_id)::int AS count
     FROM invoice_line_items
     WHERE item_id = $1`,
    [id]
  );
  if (refs[0].count > 0) {
    const n = refs[0].count;
    throw new ConflictError(
      `Cannot delete "${existing[0].name}" — it appears on ${n} invoice${n === 1 ? '' : 's'}. ` +
      `Set its quantity to 0 instead to take it out of circulation.`
    );
  }

  await query('DELETE FROM items WHERE id = $1', [id]);
  res.json({ message: 'Item deleted successfully' });
}));

module.exports = router;
