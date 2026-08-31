/**
 * routes/users.js — staff accounts.
 *
 * Two roles: 'admin' has implicit access to every company; 'sub_admin' is
 * scoped to whatever companies an admin has assigned it (see user_companies
 * and middleware/rbac.js). Managing accounts — creating them, changing their
 * role, assigning companies — is itself an admin-only privilege, gated below.
 */
const express = require('express');
const bcrypt = require('bcrypt');
const { query, runTransaction, PG_UNIQUE_VIOLATION } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/asyncHandler');
const { NotFoundError, ConflictError } = require('../lib/errors');
const v = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);
router.use(requireAdmin);

const BCRYPT_ROUNDS = 12;

// Every read goes through this list so a password hash can never be returned
// by forgetting to exclude it.
const USER_FIELDS = 'id, username, role, created_at';

/**
 * Count accounts while holding a lock on every row, so two concurrent deletes
 * cannot both observe "there are 2 accounts" and proceed.
 *
 * Emptying the users table would lock everyone out of the application for good
 * — there is no sign-up, so the last account is the only way back in.
 */
async function lockAndCountUsers(client) {
  const { rows } = await client.query('SELECT id FROM users FOR UPDATE');
  return rows.length;
}

/**
 * Count admins while holding the same row lock as lockAndCountUsers.
 *
 * A sub-admin can only be created, assigned companies, or promoted by an
 * admin — so losing the last one wouldn't just lock someone out, it would
 * strand every sub-admin's companies with nobody able to manage them.
 */
async function countAdmins(client) {
  const { rows } = await client.query(`SELECT id FROM users WHERE role = 'admin' FOR UPDATE`);
  return rows.length;
}

// GET /api/users
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT ${USER_FIELDS} FROM users ORDER BY username`);
  res.json(rows);
}));

// GET /api/users/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'User id');
  const { rows } = await query(`SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('User not found');
  res.json(rows[0]);
}));

// POST /api/users
router.post('/', asyncHandler(async (req, res) => {
  const username = v.username(req.body.username);
  const pw       = v.password(req.body.password);
  const role     = v.role(req.body.role);

  const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);

  try {
    const { rows } = await query(
      `INSERT INTO users (username, password, role)
       VALUES ($1, $2, $3)
       RETURNING ${USER_FIELDS}`,
      [username, hash, role]
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

  // Only hash if a new password was actually supplied.
  const newPassword = req.body.password;
  const hash = (newPassword === undefined || newPassword === null || newPassword === '')
    ? null
    : await bcrypt.hash(v.password(newPassword), BCRYPT_ROUNDS);

  const updated = await runTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT role FROM users WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!existing[0]) throw new NotFoundError('User not found');
    const role = v.role(req.body.role, { fallback: existing[0].role });

    // Demoting the last admin would leave nobody able to manage accounts or
    // company assignments — same invariant as the delete guard below.
    if (existing[0].role === 'admin' && role !== 'admin' && (await countAdmins(client)) <= 1) {
      throw new ConflictError(
        'This is the only admin — promote another account to admin before changing this one.'
      );
    }

    try {
      const { rows } = await client.query(
        `UPDATE users
         SET username = $1,
             password = COALESCE($2, password),
             role     = $3
         WHERE id = $4
         RETURNING ${USER_FIELDS}`,
        [username, hash, role, id]
      );
      return rows[0];
    } catch (err) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        throw new ConflictError('That username is already taken');
      }
      throw err;
    }
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
    if (!existing[0]) throw new NotFoundError('User not found');

    if (await lockAndCountUsers(client) <= 1) {
      throw new ConflictError(
        'This is the only account — create another before deleting this one.'
      );
    }
    if (existing[0].role === 'admin' && (await countAdmins(client)) <= 1) {
      throw new ConflictError(
        'This is the only admin — promote another account to admin before deleting this one.'
      );
    }

    await client.query('DELETE FROM users WHERE id = $1', [id]);
  });

  res.json({ message: 'User deleted successfully' });
}));

// GET /api/users/:id/companies — companies assigned to a sub-admin
router.get('/:id/companies', asyncHandler(async (req, res) => {
  const id = v.id(req.params.id, 'User id');
  const { rows } = await query(
    `SELECT c.id, c.name
     FROM user_companies uc
     JOIN companies c ON c.id = uc.company_id
     WHERE uc.user_id = $1
     ORDER BY c.name`,
    [id]
  );
  res.json(rows);
}));

// POST /api/users/:id/companies — assign a company to a sub-admin
router.post('/:id/companies', asyncHandler(async (req, res) => {
  const id        = v.id(req.params.id, 'User id');
  const companyId = v.id(req.body.company_id, 'company_id');

  const { rows: userRows } = await query('SELECT role FROM users WHERE id = $1', [id]);
  if (!userRows[0]) throw new NotFoundError('User not found');
  if (userRows[0].role !== 'sub_admin') {
    throw new ConflictError(
      'Only a sub-admin can be assigned specific companies — an admin already has access to all of them'
    );
  }

  const { rows: companyRows } = await query('SELECT id FROM companies WHERE id = $1', [companyId]);
  if (!companyRows[0]) throw new NotFoundError('Company not found');

  await query(
    `INSERT INTO user_companies (user_id, company_id) VALUES ($1, $2)
     ON CONFLICT (user_id, company_id) DO NOTHING`,
    [id, companyId]
  );
  res.status(201).json({ message: 'Company assigned' });
}));

// DELETE /api/users/:id/companies/:companyId — unassign
router.delete('/:id/companies/:companyId', asyncHandler(async (req, res) => {
  const id        = v.id(req.params.id, 'User id');
  const companyId = v.id(req.params.companyId, 'Company id');
  await query(
    'DELETE FROM user_companies WHERE user_id = $1 AND company_id = $2',
    [id, companyId]
  );
  res.json({ message: 'Company unassigned' });
}));

module.exports = router;
