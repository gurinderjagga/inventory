/**
 * middleware/authorize.js
 * Role checks and tenant scoping.
 *
 * Two roles exist:
 *   admin         — platform administrator; unrestricted across all companies
 *   company_admin — belongs to exactly one company; may only touch its data
 *
 * The scoping approach is deliberate. Rather than fetching a row and then
 * comparing its company_id in JavaScript, `companyScope()` yields a value that
 * is passed straight into the query:
 *
 *   WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)
 *
 * For a platform admin the scope is NULL and the predicate is always true; for
 * a company admin it pins the row to their company. A cross-tenant id then
 * simply matches nothing and the existing "not found" branch answers 404 — no
 * separate authorisation step to forget, and no code path where a row is read
 * before it is authorised.
 */
const { ForbiddenError, NotFoundError, ValidationError } = require('../lib/errors');
const v = require('../lib/validate');

/** True when the caller is a platform administrator. */
const isAdmin = (req) => req.user?.role === 'admin';

/**
 * The company id every query for this caller must be restricted to,
 * or null for a platform admin (meaning: no restriction).
 */
const companyScope = (req) => (isAdmin(req) ? null : req.user.company_id);

/**
 * Route middleware for platform-admin-only endpoints.
 * 403 is correct here: these are capabilities, not hidden records.
 */
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return next(new ForbiddenError('This action requires a platform administrator account'));
  }
  next();
}

/**
 * Assert the caller may act on `companyId`.
 *
 * Answers 404 rather than 403 so a company admin cannot enumerate which
 * company ids exist on the platform.
 *
 * @throws {NotFoundError}
 */
function assertCompanyAccess(req, companyId, message = 'Not found') {
  if (isAdmin(req)) return;
  if (Number(companyId) !== Number(req.user.company_id)) {
    throw new NotFoundError(message);
  }
}

/**
 * Resolve the company a write should be attributed to.
 *
 * A company admin may omit company_id (their own is implied) but may never
 * name a different one — so a forged body cannot plant data in another tenant.
 * A platform admin must always say which company they mean.
 *
 * @returns {number} the company id to write against
 * @throws {ValidationError|NotFoundError}
 */
function resolveCompanyId(req, raw, field = 'company_id') {
  const absent = raw === undefined || raw === null || raw === '';

  if (absent) {
    if (isAdmin(req)) throw new ValidationError(`${field} is required`);
    return req.user.company_id;
  }

  const id = v.id(raw, field);
  assertCompanyAccess(req, id, 'Company not found');
  return id;
}

module.exports = { isAdmin, companyScope, requireAdmin, assertCompanyAccess, resolveCompanyId };
