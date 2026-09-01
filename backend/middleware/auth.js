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

  // One round trip instead of two: the company-id list is pulled via a LEFT
  // JOIN + array_agg rather than a separate query gated on role. Harmless
  // for an admin (the join just finds nothing to aggregate) and a genuine
  // round-trip cut for every sub-admin request, which is every request that
  // role ever makes.
  const { rows } = await query(
    `SELECT u.id, u.username, u.role,
            COALESCE(array_agg(uc.company_id) FILTER (WHERE uc.company_id IS NOT NULL), ARRAY[]::int[]) AS company_ids
     FROM users u
     LEFT JOIN user_companies uc ON uc.user_id = u.id
     WHERE u.id = $1
     GROUP BY u.id`,
    [payload.id]
  );

  const row = rows[0];
  if (!row) {
    // The account was deleted while the cookie was still valid.
    return res.status(401).json({ error: 'Your account no longer exists — please log in again' });
  }

  // An admin's access is implicit (every company), so companyIds is only
  // attached for a sub-admin — the one role whose access is actually a
  // subset — keeping req.user's shape exactly what it was before this query
  // was merged into one.
  const user = { id: row.id, username: row.username, role: row.role };
  if (user.role === 'sub_admin') {
    user.companyIds = row.company_ids;
    // A Set alongside the array, not instead of it: features.js needs the
    // array form for `= ANY($2)` and `.length`, while rbac.js and
    // companies.js only ever ask "is this one id in the set" — an O(1)
    // .has() rather than a linear .includes() scan repeated once per company.
    user.companyIdSet = new Set(row.company_ids);
  }

  req.user = user;
  next();
}

// Wrapped so a database failure during auth reaches the global error handler
// instead of leaving the request hanging.
const authMiddleware = asyncHandler(authMiddlewareImpl);

module.exports = { authMiddleware, JWT_SECRET };
