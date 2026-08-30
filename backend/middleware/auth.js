const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { query } = require('../database/db');
const { asyncHandler } = require('./asyncHandler');

/**
 * Verify the session cookie, then load the account from the database on every
 * request.
 *
 * The token deliberately carries only the user id. Reading the account back
 * costs one primary-key lookup and makes deletion of the account take effect on
 * the very next request, rather than whenever a 24-hour token happens to
 * expire.
 */
async function authMiddlewareImpl(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized — please log in' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session — please log in again' });
  }

  const { rows } = await query(
    'SELECT id, username FROM users WHERE id = $1',
    [payload.id]
  );

  const user = rows[0];
  if (!user) {
    // The account was deleted while the cookie was still valid.
    return res.status(401).json({ error: 'Your account no longer exists — please log in again' });
  }

  req.user = user;
  next();
}

// Wrapped so a database failure during auth reaches the global error handler
// instead of leaving the request hanging.
const authMiddleware = asyncHandler(authMiddlewareImpl);

module.exports = { authMiddleware, JWT_SECRET };
