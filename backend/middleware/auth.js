const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { query } = require('../database/db');
const { asyncHandler } = require('./asyncHandler');

/**
 * Verify the session cookie, then load the user's role and company from the
 * database on every request.
 *
 * The token deliberately carries only the user id. Roles are authorisation
 * state, and baking them into a 24-hour token means a demoted or offboarded
 * account keeps its old privileges until that token expires. Reading them back
 * costs one primary-key lookup and makes a change of role — or deletion of the
 * account — take effect on the very next request.
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
    `SELECT u.id, u.username, u.role, u.company_id, c.name AS company_name
     FROM users u
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.id = $1`,
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
