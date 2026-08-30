/**
 * routes/users.js — staff accounts.
 *
 * Everyone who can sign in is staff, with the same access: companies are
 * records whose stock we manage, not tenants who log in, so there is no role
 * and no per-company scoping. Any signed-in account may manage accounts.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, runTransaction, PG_UNIQUE_VIOLATION } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { NotFoundError, ConflictError } = require('../lib/errors');
const v = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);

const BCRYPT_ROUNDS = 12;

// Every read goes through this list so a password hash can never be returned
// by forgetting to exclude it.
const USER_FIELDS = 'id, username, created_at';

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

  const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);

  try {
    const { rows } = await query(
      `INSERT INTO users (username, password)
       VALUES ($1, $2)
       RETURNING ${USER_FIELDS}`,
      [username, hash]
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

  try {
    const { rows } = await query(
      `UPDATE users
       SET username = $1,
           password = COALESCE($2, password)
       WHERE id = $3
       RETURNING ${USER_FIELDS}`,
      [username, hash, id]
    );
    if (!rows[0]) throw new NotFoundError('User not found');
    res.json(rows[0]);
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw new ConflictError('That username is already taken');
    }
    throw err;
  }
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
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!existing[0]) throw new NotFoundError('User not found');

    if (await lockAndCountUsers(client) <= 1) {
      throw new ConflictError(
        'This is the only account — create another before deleting this one.'
      );
    }

    await client.query('DELETE FROM users WHERE id = $1', [id]);
  });

  res.json({ message: 'User deleted successfully' });
}));

module.exports = router;
