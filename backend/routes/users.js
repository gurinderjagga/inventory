/**
 * routes/users.js — account provisioning. Platform administrators only.
 *
 * Company admins manage their company's *data*, not accounts, so this whole
 * router is gated behind requireAdmin.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, runTransaction, PG_UNIQUE_VIOLATION } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAdmin } = require('../middleware/authorize');
const { ValidationError, NotFoundError, ConflictError } = require('../lib/errors');
const v = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware, requireAdmin);

const BCRYPT_ROUNDS = 12;

// Every read goes through this list so a password hash can never be returned
// by forgetting to exclude it.
const USER_FIELDS = `
  u.id, u.username, u.role, u.company_id, u.created_at,
  c.name AS company_name
`;

/**
 * Validate the role/company pairing.
 *
 * The database enforces this too (users_scope_ck), but checking here turns a
 * constraint violation into a message that says which field is wrong.
 *
 * @returns {{role: string, companyId: number|null}}
 */
async function readRoleAndCompany(body) {
  const role = body.role;
  if (role !== 'admin' && role !== 'company_admin') {
    throw new ValidationError(`role must be either "admin" or "company_admin"`);
  }

  if (role === 'admin') {
    if (body.company_id !== undefined && body.company_id !== null && body.company_id !== '') {
      throw new ValidationError('A platform admin cannot be tied to a company');
    }
    return { role, companyId: null };
  }

  const companyId = v.id(body.company_id, 'company_id');
  const { rows } = await query('SELECT id FROM companies WHERE id = $1', [companyId]);
  if (!rows[0]) throw new NotFoundError('Company not found');
  return { role, companyId };
}

/**
 * Count platform admins while holding a lock on every admin row, so two
 * concurrent demotions cannot both observe "there are 2 admins" and proceed.
 */
async function lockAndCountAdmins(client) {
  const { rows } = await client.query(`SELECT id FROM users WHERE role = 'admin' FOR UPDATE`);
  return rows.length;
}

// GET /api/users
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(`
    SELECT ${USER_FIELDS}
    FROM users u
    LEFT JOIN companies c ON c.id = u.company_id
    ORDER BY u.role, u.username
  `);
  res.json(rows);
}));

// GET /api/users/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'User id');
  const { rows } = await query(`
    SELECT ${USER_FIELDS}
    FROM users u
    LEFT JOIN companies c ON c.id = u.company_id
    WHERE u.id = $1
  `, [id]);
  if (!rows[0]) throw new NotFoundError('User not found');
  res.json(rows[0]);
}));

// POST /api/users
router.post('/', asyncHandler(async (req, res) => {
  const username = v.username(req.body.username);
  const pw       = v.password(req.body.password);
  const { role, companyId } = await readRoleAndCompany(req.body);

  const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);

  try {
    const { rows } = await query(
      `INSERT INTO users (username, password, role, company_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, role, company_id, created_at`,
      [username, hash, role, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw new ConflictError('That username is already taken');
    }
    throw err;
  }
}));

// PUT /api/users/:id  — password is optional; omit it to leave it unchanged
router.put('/:id', asyncHandler(async (req, res) => {
  const id       = v.id(req.params.id, 'User id');
  const username = v.username(req.body.username);
  const { role, companyId } = await readRoleAndCompany(req.body);

  // Only hash if a new password was actually supplied.
  const newPassword = req.body.password;
  const hash = (newPassword === undefined || newPassword === null || newPassword === '')
    ? null
    : await bcrypt.hash(v.password(newPassword), BCRYPT_ROUNDS);

  const updated = await runTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT id, username, role FROM users WHERE id = $1 FOR UPDATE',
      [id]
    );
    const target = existing[0];
    if (!target) throw new NotFoundError('User not found');

    // Demoting the only platform admin would leave nobody able to manage
    // companies or accounts, with no way back in through the UI.
    if (target.role === 'admin' && role !== 'admin') {
      if (await lockAndCountAdmins(client) <= 1) {
        throw new ConflictError(
          'This is the only platform administrator — promote another account before changing this one.'
        );
      }
    }

    const { rows } = await client.query(
      `UPDATE users
       SET username = $1,
           role = $2,
           company_id = $3,
           password = COALESCE($4, password)
       WHERE id = $5
       RETURNING id, username, role, company_id, created_at`,
      [username, role, companyId, hash, id]
    );
    return rows[0];
  });

  res.json(updated);
}));

// DELETE /api/users/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'User id');

  // Deleting the account you are signed in as is almost always a mistake, and
  // the session would die mid-request.
  if (id === req.user.id) {
    throw new ConflictError('You cannot delete the account you are signed in with');
  }

  await runTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT id, role FROM users WHERE id = $1 FOR UPDATE',
      [id]
    );
    const target = existing[0];
    if (!target) throw new NotFoundError('User not found');

    if (target.role === 'admin' && await lockAndCountAdmins(client) <= 1) {
      throw new ConflictError(
        'This is the only platform administrator — create another before deleting this one.'
      );
    }

    await client.query('DELETE FROM users WHERE id = $1', [id]);
  });

  res.json({ message: 'User deleted successfully' });
}));

module.exports = router;
