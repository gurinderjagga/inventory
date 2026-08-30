const express = require('express');
const { query, PG_UNIQUE_VIOLATION } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { NotFoundError, ConflictError } = require('../lib/errors');
const v = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);

/** Read and validate the company payload shared by POST and PUT. */
function readBody(body) {
  return {
    name:    v.requiredString(body.name, 'Company name'),
    email:   v.optionalString(body.email),
    phone:   v.optionalString(body.phone),
    address: v.optionalString(body.address),
  };
}

// GET /api/companies  — all companies with item + low stock counts.
// A company admin sees only their own company.
router.get('/', asyncHandler(async (req, res) => {
  // COALESCE keeps the aggregates numeric for companies with no items,
  // where SUM() would otherwise return NULL.
  const { rows } = await query(`
    SELECT
      c.*,
      COUNT(i.id)                                                            AS item_count,
      COALESCE(SUM(CASE WHEN i.quantity <= i.low_stock_threshold THEN 1 ELSE 0 END), 0) AS low_stock_count,
      COALESCE(SUM(i.quantity * i.unit_price), 0)                            AS stock_value
    FROM companies c
    LEFT JOIN items i ON i.company_id = c.id
    GROUP BY c.id
    ORDER BY c.name
  `);

  // COUNT/SUM over bigint come back as strings from pg; the client expects
  // numbers for arithmetic and comparisons.
  res.json(rows.map(r => ({
    ...r,
    item_count:      Number(r.item_count),
    low_stock_count: Number(r.low_stock_count),
    stock_value:     Number(r.stock_value),
  })));
}));

// GET /api/companies/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Company id');
  const { rows } = await query('SELECT * FROM companies WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Company not found');
  res.json(rows[0]);
}));

// POST /api/companies
router.post('/', asyncHandler(async (req, res) => {
  const c = readBody(req.body);
  try {
    const { rows } = await query(
      `INSERT INTO companies (name, email, phone, address)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [c.name, c.email, c.phone, c.address]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw new ConflictError('A company with that name already exists');
    }
    throw err;
  }
}));

// PUT /api/companies/:id
router.put('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Company id');
  const c  = readBody(req.body);
  try {
    const { rows } = await query(
      `UPDATE companies SET name = $1, email = $2, phone = $3, address = $4
       WHERE id = $5
       RETURNING *`,
      [c.name, c.email, c.phone, c.address, id]
    );
    if (!rows[0]) throw new NotFoundError('Company not found');
    res.json(rows[0]);
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw new ConflictError('A company with that name already exists');
    }
    throw err;
  }
}));

// DELETE /api/companies/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Company id');

  const { rows: existing } = await query('SELECT name FROM companies WHERE id = $1', [id]);
  if (!existing[0]) throw new NotFoundError('Company not found');

  // Items cascade, but invoices deliberately do not: deleting a company that
  // has been invoiced would destroy financial history.
  const { rows: refs } = await query(
    'SELECT COUNT(*)::int AS count FROM invoices WHERE company_id = $1',
    [id]
  );
  if (refs[0].count > 0) {
    const n = refs[0].count;
    throw new ConflictError(
      `Cannot delete "${existing[0].name}" — it has ${n} invoice${n === 1 ? '' : 's'}. ` +
      `Delete ${n === 1 ? 'that invoice' : 'those invoices'} first, or keep the company for your records.`
    );
  }

  await query('DELETE FROM companies WHERE id = $1', [id]);
  res.json({ message: 'Company deleted successfully' });
}));

module.exports = router;
