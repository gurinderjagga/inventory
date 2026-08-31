const express = require('express');
const { query, PG_UNIQUE_VIOLATION } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { requireAdmin, requireCompanyAccess } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/asyncHandler');
const { NotFoundError, ConflictError, ValidationError } = require('../lib/errors');
const v = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);

const SCHEMES = ['regular', 'composition'];

/** Read and validate the company payload shared by POST and PUT. */
function readBody(body) {
  const scheme = v.optionalString(body.scheme) || 'regular';
  if (!SCHEMES.includes(scheme)) {
    throw new ValidationError(`Scheme must be one of: ${SCHEMES.join(', ')}`);
  }
  return {
    name:             v.requiredString(body.name, 'Company name'),
    email:            v.optionalString(body.email),
    phone:            v.optionalString(body.phone),
    address:          v.optionalString(body.address),
    gstin:            v.gstin(body.gstin),
    legalName:        v.optionalString(body.legal_name),
    stateCode:        v.optionalString(body.state_code),
    pan:              v.pan(body.pan),
    scheme,
    einvoiceEnabled:  v.boolean(body.einvoice_enabled),
    signatoryName:    v.optionalString(body.authorized_signatory_name),
  };
}

/** Read the archive/active flag on PUT, preserving the current value when omitted. */
function readActive(body, current) {
  return body.active === undefined ? current : v.boolean(body.active, { fallback: current });
}

// GET /api/companies  — all companies with item + low stock counts.
// An admin sees every company; a sub-admin sees only the ones assigned to it.
router.get('/', asyncHandler(async (req, res) => {
  const scoped = req.user.role === 'sub_admin';

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
    ${scoped ? 'WHERE c.id = ANY($1)' : ''}
    GROUP BY c.id
    ORDER BY c.name
  `, scoped ? [req.user.companyIds] : []);

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
router.get('/:id', requireCompanyAccess(req => req.params.id), asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Company id');
  const { rows } = await query('SELECT * FROM companies WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Company not found');
  res.json(rows[0]);
}));

/** GSTIN and name both sit behind partial/plain unique indexes on this table. */
function throwOnUniqueViolation(err) {
  if (err.code !== PG_UNIQUE_VIOLATION) throw err;
  if (err.constraint === 'idx_companies_gstin') {
    throw new ConflictError('A company with that GSTIN already exists');
  }
  throw new ConflictError('A company with that name already exists');
}

// POST /api/companies — creating a new tenant record is admin-only; a
// sub-admin can only be given access to companies that already exist.
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const c = readBody(req.body);
  try {
    const { rows } = await query(
      `INSERT INTO companies (name, email, phone, address, gstin, legal_name, state_code, pan, scheme, einvoice_enabled, authorized_signatory_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [c.name, c.email, c.phone, c.address, c.gstin, c.legalName, c.stateCode, c.pan, c.scheme, c.einvoiceEnabled, c.signatoryName]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    throwOnUniqueViolation(err);
  }
}));

// PUT /api/companies/:id — a sub-admin may edit a company it manages.
router.put('/:id', requireCompanyAccess(req => req.params.id), asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Company id');
  const c  = readBody(req.body);

  const { rows: existing } = await query('SELECT active FROM companies WHERE id = $1', [id]);
  if (!existing[0]) throw new NotFoundError('Company not found');
  const active = readActive(req.body, existing[0].active);

  try {
    const { rows } = await query(
      `UPDATE companies
       SET name = $1, email = $2, phone = $3, address = $4, gstin = $5, legal_name = $6,
           state_code = $7, pan = $8, scheme = $9, einvoice_enabled = $10, active = $11,
           authorized_signatory_name = $12, updated_at = now()
       WHERE id = $13
       RETURNING *`,
      [c.name, c.email, c.phone, c.address, c.gstin, c.legalName, c.stateCode, c.pan,
        c.scheme, c.einvoiceEnabled, active, c.signatoryName, id]
    );
    if (!rows[0]) throw new NotFoundError('Company not found');
    res.json(rows[0]);
  } catch (err) {
    throwOnUniqueViolation(err);
  }
}));

// DELETE /api/companies/:id — destructive and tenant-level, so admin-only
// even for a sub-admin who otherwise manages this company.
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'Company id');

  const { rows: existing } = await query('SELECT name FROM companies WHERE id = $1', [id]);
  if (!existing[0]) throw new NotFoundError('Company not found');

  await query('DELETE FROM stock_movements WHERE company_id = $1', [id]);
  await query('DELETE FROM invoice_number_series WHERE company_id = $1', [id]);
  await query('DELETE FROM invoices WHERE company_id = $1', [id]);
  await query('DELETE FROM companies WHERE id = $1', [id]);
  res.json({ message: 'Company deleted successfully' });
}));

module.exports = router;
