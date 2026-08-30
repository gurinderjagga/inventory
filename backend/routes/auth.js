const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../database/db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { loginLimiter, passwordChangeLimiter } = require('../middleware/rateLimit');
const { COOKIE_SAMESITE, COOKIE_SECURE } = require('../config');
const v = require('../lib/validate');

const router = express.Router();

// SameSite/Secure are derived from whether the frontend is on another origin.
// Same-origin: Lax, which blocks the cross-site requests that drive CSRF.
// Cross-origin: None + Secure, the only combination browsers will send
// cross-site — see the CSRF note in server.js for what compensates.
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: COOKIE_SECURE,
  sameSite: COOKIE_SAMESITE,
  path: '/',
};

// POST /api/auth/login
router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const { rows } = await query(
    'SELECT id, username, password FROM users WHERE username = $1',
    [username.trim()]
  );
  const user = rows[0];
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Only the id goes in the token — the account is read from the database on
  // each request, so a deletion takes effect immediately.
  const token = jwt.sign(
    { id: user.id },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.cookie('token', token, { ...COOKIE_OPTIONS, maxAge: 24 * 60 * 60 * 1000 });
  res.json({
    message:  'Login successful',
    id:       user.id,
    username: user.username,
  });
}));

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  // Options must match those used to set the cookie, or the browser keeps it.
  res.clearCookie('token', COOKIE_OPTIONS);
  res.json({ message: 'Logged out successfully' });
});

// POST /api/auth/change-password  — any signed-in user, own account only
router.post('/change-password', passwordChangeLimiter, authMiddleware, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password) {
    return res.status(400).json({ error: 'Your current password is required' });
  }
  const next = v.password(new_password, 'New password');

  const { rows } = await query('SELECT password FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) {
    return res.status(401).json({ error: 'Your account no longer exists — please log in again' });
  }

  // Requiring the current password stops someone with a stolen cookie from
  // locking the real owner out of their account.
  const valid = await bcrypt.compare(current_password, rows[0].password);
  if (!valid) {
    return res.status(400).json({ error: 'Your current password is not correct' });
  }

  if (current_password === next) {
    return res.status(400).json({ error: 'The new password must be different from the current one' });
  }

  const hash = await bcrypt.hash(next, 12);
  await query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.user.id]);

  res.json({ message: 'Password changed successfully' });
}));

// GET /api/auth/me  — verify the session and report who is signed in
router.get('/me', authMiddleware, (req, res) => {
  res.json({
    id:       req.user.id,
    username: req.user.username,
  });
});

module.exports = router;
