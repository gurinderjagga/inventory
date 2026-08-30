const express = require('express');
const { query, PG_UNIQUE_VIOLATION } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { NotFoundError, ConflictError } = require('../lib/errors');
const v = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);

/** Read and validate the customer payload shared by POST and PUT. */
function readBody(body) {
  return {
    name:      v.requiredString(body.name, 'Customer name'),
    address:   v.optionalString(body.address),
    gstin:     v.gstin(body.gstin),
    stateCode: v.optionalString(body.state_code),
  };
}

/** Read the archive/active flag on PUT, preserving the current value when omitted. */
function readActive(body, current) {
  return body.active === undefined ? current : v.boolean(body.active, { fallback: current });
}

// GET /api/customers/company/:companyId  — customers scoped to a company
router.get('/company/:companyId', asyncHandler(async (req, res) => {
  const companyId = v.id(req.params.companyId, 'Company id');
  const { rows } = await query(
    'SELECT * FROM customers WHERE company_id = $1 ORDER BY name ASC',
    [companyId]
  );
  res.json(rows);
}));

// GET /api/customers/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Customer id');
  const { rows } = await query('SELECT * FROM customers WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Customer not found');
  res.json(rows[0]);
}));

// POST /api/customers
router.post('/', asyncHandler(async (req, res) => {
  const companyId = v.id(req.body.company_id, 'company_id');
  const c         = readBody(req.body);

  // Check the parent exists so a bad company_id reads as a bad request rather
  // than a foreign-key failure.
  const { rows: company } = await query('SELECT id FROM companies WHERE id = $1', [companyId]);
  if (!company[0]) throw new NotFoundError('Company not found');

  try {
    const { rows } = await query(
      `INSERT INTO customers (company_id, name, address, gstin, state_code)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [companyId, c.name, c.address, c.gstin, c.stateCode]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw new ConflictError('A customer with that GSTIN already exists for this company');
    }
    throw err;
  }
}));

// PUT /api/customers/:id
router.put('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Customer id');
  const c  = readBody(req.body);

  const { rows: existing } = await query('SELECT active FROM customers WHERE id = $1', [id]);
  if (!existing[0]) throw new NotFoundError('Customer not found');
  const active = readActive(req.body, existing[0].active);

  try {
    const { rows } = await query(
      `UPDATE customers
       SET name = $1, address = $2, gstin = $3, state_code = $4, active = $5, updated_at = now()
       WHERE id = $6
       RETURNING *`,
      [c.name, c.address, c.gstin, c.stateCode, active, id]
    );
    if (!rows[0]) throw new NotFoundError('Customer not found');
    res.json(rows[0]);
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw new ConflictError('A customer with that GSTIN already exists for this company');
    }
    throw err;
  }
}));

// DELETE /api/customers/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Customer id');

  const { rows: existing } = await query('SELECT name FROM customers WHERE id = $1', [id]);
  if (!existing[0]) throw new NotFoundError('Customer not found');

  const { rows: refs } = await query(
    'SELECT COUNT(*)::int AS count FROM invoices WHERE customer_id = $1',
    [id]
  );
  if (refs[0].count > 0) {
    const n = refs[0].count;
    throw new ConflictError(
      `Cannot delete "${existing[0].name}" — it has ${n} invoice${n === 1 ? '' : 's'}. ` +
      `Archive the customer instead to keep your records intact.`
    );
  }

  await query('DELETE FROM customers WHERE id = $1', [id]);
  res.json({ message: 'Customer deleted successfully' });
}));

module.exports = router;
