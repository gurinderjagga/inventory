/**
 * routes/stock.js
 *
 * Simple stock movement endpoints replacing the invoicing workflow.
 *
 *   POST /api/stock/in          — receive stock for an item
 *   POST /api/stock/out         — dispatch stock from an item
 *   GET  /api/stock/movements   — paginated movement history for a company
 */
const express = require('express');
const { query, runTransaction } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { requireCompanyAccess } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/asyncHandler');
const { NotFoundError, ConflictError, ValidationError } = require('../lib/errors');
const v = require('../lib/validate');
const money = require('../lib/money');
const { applyMovement } = require('../lib/stockLedger');

const router = express.Router();
router.use(authMiddleware);

// ── POST /api/stock/in ───────────────────────────────────────────────────────
// Receive stock: increase an item's quantity and log a 'stock_in' movement.
router.post('/in', requireCompanyAccess(req => req.body.company_id), asyncHandler(async (req, res) => {
  const companyId = v.id(req.body.company_id, 'company_id');
  const itemId    = v.id(req.body.item_id, 'item_id');
  const quantity  = money.quantity(v.nonNegativeNumber(req.body.quantity, 'Quantity'));
  const note      = v.optionalString(req.body.note);

  if (money.dec(quantity).isZero()) {
    throw new ValidationError('Quantity must be greater than zero');
  }

  // Verify item belongs to the given company.
  const { rows: items } = await query(
    'SELECT id, name FROM items WHERE id = $1 AND company_id = $2',
    [itemId, companyId]
  );
  if (!items[0]) throw new NotFoundError('Item not found for this company');

  const newQuantity = await runTransaction(async (client) => {
    return applyMovement(client, {
      itemId, companyId,
      delta:  quantity,
      reason: 'stock_in',
      note,
      userId: req.user.id,
    });
  });

  res.status(201).json({
    message:      'Stock received',
    item_id:      itemId,
    item_name:    items[0].name,
    quantity_added: Number(quantity),
    new_quantity: newQuantity,
  });
}));

// ── POST /api/stock/out ──────────────────────────────────────────────────────
// Dispatch stock: decrease an item's quantity and log a 'stock_out' movement.
router.post('/out', requireCompanyAccess(req => req.body.company_id), asyncHandler(async (req, res) => {
  const companyId = v.id(req.body.company_id, 'company_id');
  const itemId    = v.id(req.body.item_id, 'item_id');
  const quantity  = money.quantity(v.nonNegativeNumber(req.body.quantity, 'Quantity'));
  const note      = v.optionalString(req.body.note);

  if (money.dec(quantity).isZero()) {
    throw new ValidationError('Quantity must be greater than zero');
  }

  const newQuantity = await runTransaction(async (client) => {
    // Lock the row to prevent races between concurrent dispatches.
    const { rows } = await client.query(
      'SELECT id, name, quantity FROM items WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [itemId, companyId]
    );
    if (!rows[0]) throw new NotFoundError('Item not found for this company');

    const current = money.dec(rows[0].quantity);
    if (current.lt(money.dec(quantity))) {
      throw new ConflictError(
        `Insufficient stock — only ${current.toFixed(3)} units available, ` +
        `but ${money.dec(quantity).toFixed(3)} requested`
      );
    }

    return applyMovement(client, {
      itemId, companyId,
      delta:  money.dec(quantity).negated().toString(),
      reason: 'stock_out',
      note,
      userId: req.user.id,
    });
  });

  res.status(201).json({
    message:         'Stock dispatched',
    item_id:         itemId,
    quantity_removed: Number(quantity),
    new_quantity:    newQuantity,
  });
}));

// ── GET /api/stock/movements ─────────────────────────────────────────────────
// Paginated movement history for a company, newest first.
// Query params: company_id (required), page (default 1), limit (default 50)
router.get('/movements', requireCompanyAccess(req => req.query.company_id), asyncHandler(async (req, res) => {
  const companyId = v.id(req.query.company_id, 'company_id');
  const page      = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit     = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset    = (page - 1) * limit;

  const { rows } = await query(`
    SELECT
      m.id,
      m.reason,
      m.quantity_delta,
      m.note,
      m.created_at,
      i.id          AS item_id,
      i.name        AS item_name,
      i.unit        AS item_unit,
      u.username    AS performed_by
    FROM stock_movements m
    JOIN items i ON i.id = m.item_id
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.company_id = $1
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT $2 OFFSET $3
  `, [companyId, limit, offset]);

  const { rows: countRows } = await query(
    'SELECT COUNT(*)::int AS total FROM stock_movements WHERE company_id = $1',
    [companyId]
  );

  res.json({
    movements: rows,
    total:     countRows[0].total,
    page,
    limit,
    pages:     Math.ceil(countRows[0].total / limit),
  });
}));

module.exports = router;
