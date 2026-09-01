/**
 * middleware/rbac.js
 * Role and company-scoping gates, layered on top of authMiddleware.
 *
 * Two access shapes exist in this app:
 *   - admin      — implicit access to every company; no user_companies rows.
 *   - sub_admin  — access only to the companies in req.user.companyIds,
 *                  loaded once per request by authMiddleware.
 */
const { query } = require('../database/db');
const { NotFoundError, ForbiddenError } = require('../lib/errors');
const { FEATURES } = require('../lib/features');
const cache = require('../lib/memoryCache');
const { asyncHandler } = require('./asyncHandler');

// Feature toggles only change when an admin deliberately flips one (see
// routes/features.js, which evicts this same key immediately on write) — a
// short TTL is just a safety net against a cache entry outliving a restart
// or an eviction that got missed, not the primary freshness mechanism.
const FEATURE_CACHE_TTL_MS = 30_000;
const featureCacheKey = (companyId, key) => `feature:${companyId}:${key}`;

/**
 * Gate a whole endpoint to admins only. Use this where the privilege itself —
 * not a particular company's data — is what's being protected: creating an
 * account, deleting a company, assigning companies to a sub-admin. That a
 * caller needs to be an admin is not a secret, so this answers 403 (see the
 * ForbiddenError contract in lib/errors.js).
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return next(new ForbiddenError('Only an admin can do that'));
  }
  next();
}

/**
 * Gate access to a single company's data.
 *
 * `getCompanyId(req)` resolves the company id the request touches — a route
 * param, a body field, or (for a route keyed by another resource's id, like
 * an item) an async lookup. May be sync or async; both are awaited.
 *
 * Answers 404, not 403: a sub-admin probing another company's id should not
 * be able to tell "doesn't exist" apart from "exists, just not yours" — same
 * reasoning as the ForbiddenError doc comment in lib/errors.js.
 */
function requireCompanyAccess(getCompanyId) {
  return asyncHandler(async (req, res, next) => {
    if (req.user.role === 'admin') return next();

    const companyId = await getCompanyId(req);
    if (!companyId || !req.user.companyIdSet.has(Number(companyId))) {
      throw new NotFoundError('Company not found');
    }
    next();
  });
}

/**
 * Gate a route on a per-company feature toggle (see lib/features.js and
 * company_features). Apply this AFTER requireCompanyAccess — access first
 * (404 if the company isn't even yours), then the feature (403 if it's
 * yours but the feature is off, which is not tenant-secret information).
 *
 * `getCompanyId(req)` is the same kind of resolver requireCompanyAccess
 * takes — a route param, a body field, or an async lookup.
 */
function requireFeature(key, getCompanyId) {
  return asyncHandler(async (req, res, next) => {
    const companyId = await getCompanyId(req);
    const cacheKey  = featureCacheKey(companyId, key);

    const enabled = await cache.getOrFetch(cacheKey, FEATURE_CACHE_TTL_MS, async () => {
      const { rows } = await query(
        'SELECT 1 FROM company_features WHERE company_id = $1 AND feature_key = $2',
        [companyId, key]
      );
      return rows.length > 0;
    });

    if (!enabled) {
      const label = FEATURES[key]?.label ?? key;
      throw new ForbiddenError(`${label} is not enabled for this company`);
    }
    next();
  });
}

module.exports = { requireAdmin, requireCompanyAccess, requireFeature, featureCacheKey };
