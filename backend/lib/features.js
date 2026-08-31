/**
 * lib/features.js — the registry of togglable per-company features.
 *
 * A key here is a closed set, mirrored into a database CHECK constraint (see
 * addFeatureFlags() in database/db.js) — adding a feature means adding it here
 * AND writing a migration to extend that constraint, the same two-step every
 * other closed-set column in this schema already follows (e.g. stock_movements
 * .reason). One list, so the API's 400 on a bad key and the database's
 * constraint violation can never disagree about what's valid.
 *
 * invoicing is registered but not yet wired to anything — the invoicing UI and
 * routes were removed pending a redesign. It exists here so the on/off
 * plumbing (schema, API, admin UI) is ready before that ships, rather than
 * bolted on afterward.
 */
const FEATURES = {
  invoicing: {
    label: 'Invoicing',
    description: 'Create, finalize and reverse customer invoices for this company.',
  },
};

const FEATURE_KEYS = Object.freeze(Object.keys(FEATURES));

function isValidFeatureKey(key) {
  return FEATURE_KEYS.includes(key);
}

module.exports = { FEATURES, FEATURE_KEYS, isValidFeatureKey };
