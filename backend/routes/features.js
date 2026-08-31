/**
 * routes/features.js
 *
 * Per-company feature toggles — which optional modules (invoicing, and
 * whatever joins it later) a given company has turned on. Enabling/disabling
 * is an admin-only business decision ("give a company only what it asked
 * for"); seeing what is on for a company you manage is not.
 *
 *   GET    /api/features                      — the full registry (key, label, description)
 *   GET    /api/features/company/:companyId   — the keys enabled for a company
 *   POST   /api/features/company/:companyId/:key   — enable
 *   DELETE /api/features/company/:companyId/:key   — disable
 *   GET    /api/features/enabled/:key         — is this feature on for ANY
 *                                                company the caller can reach
 *                                                (used to gate global UI, like
 *                                                a nav link, that is not
 *                                                itself scoped to one company)
 */
const express = require('express');
const { query } = require('../database/db');
const { authMiddleware } = require('../middleware/auth');
const { requireAdmin, requireCompanyAccess } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ValidationError } = require('../lib/errors');
const { FEATURES, isValidFeatureKey } = require('../lib/features');
const v = require('../lib/validate');

const router = express.Router();
router.use(authMiddleware);

/** Reject a feature key outside the registry before it ever reaches the database. */
function readFeatureKey(raw) {
  if (!isValidFeatureKey(raw)) {
    throw new ValidationError(`Unknown feature: ${raw}`);
  }
  return raw;
}

// GET /api/features — the registry itself, for building a toggle UI.
router.get('/', (req, res) => {
  res.json(Object.entries(FEATURES).map(([key, meta]) => ({ key, ...meta })));
});

// GET /api/features/enabled/:key — true if at least one company the caller
// can reach has this feature on. An admin can reach every company; a
// sub-admin only its assigned ones (req.user.companyIds, loaded once per
// request by authMiddleware — see middleware/rbac.js for the same pattern).
router.get('/enabled/:key', asyncHandler(async (req, res) => {
  const key = readFeatureKey(req.params.key);

  if (req.user.role !== 'admin' && req.user.companyIds.length === 0) {
    return res.json({ enabled: false });
  }

  const { rows } = req.user.role === 'admin'
    ? await query('SELECT 1 FROM company_features WHERE feature_key = $1 LIMIT 1', [key])
    : await query(
        'SELECT 1 FROM company_features WHERE feature_key = $1 AND company_id = ANY($2) LIMIT 1',
        [key, req.user.companyIds]
      );

  res.json({ enabled: rows.length > 0 });
}));

// GET /api/features/company/:companyId — which keys are on for this company.
router.get('/company/:companyId', requireCompanyAccess(req => req.params.companyId), asyncHandler(async (req, res) => {
  const companyId = v.id(req.params.companyId, 'Company id');
  const { rows } = await query(
    'SELECT feature_key FROM company_features WHERE company_id = $1',
    [companyId]
  );
  res.json(rows.map(r => r.feature_key));
}));

// POST /api/features/company/:companyId/:key — enable.
router.post(
  '/company/:companyId/:key',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const companyId = v.id(req.params.companyId, 'Company id');
    const key       = readFeatureKey(req.params.key);

    const { rows: company } = await query('SELECT id FROM companies WHERE id = $1', [companyId]);
    if (!company[0]) return res.status(404).json({ error: 'Company not found' });

    await query(
      `INSERT INTO company_features (company_id, feature_key) VALUES ($1, $2)
       ON CONFLICT (company_id, feature_key) DO NOTHING`,
      [companyId, key]
    );
    res.status(201).json({ message: `${FEATURES[key].label} enabled` });
  })
);

// DELETE /api/features/company/:companyId/:key — disable.
router.delete(
  '/company/:companyId/:key',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const companyId = v.id(req.params.companyId, 'Company id');
    const key       = readFeatureKey(req.params.key);

    await query(
      'DELETE FROM company_features WHERE company_id = $1 AND feature_key = $2',
      [companyId, key]
    );
    res.json({ message: `${FEATURES[key].label} disabled` });
  })
);

module.exports = router;
