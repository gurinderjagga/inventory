/**
 * config.js
 * Single source of truth for environment configuration.
 *
 * Every entry point (server.js, database/seed.js) requires this module first,
 * so `.env` is loaded exactly once regardless of how the process was started.
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const NODE_ENV     = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

/** Print a setup error and exit — a missing secret must never boot silently. */
function fatal(message, hint) {
  console.error(`\n❌  Configuration error: ${message}`);
  if (hint) console.error(`    ${hint}`);
  console.error(`    See backend/.env.example for the expected format.\n`);
  process.exit(1);
}

// ── Database ─────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  fatal('DATABASE_URL is not set.', 'Copy backend/.env.example to backend/.env and fill in your Postgres URL.');
}

// ── Auth ─────────────────────────────────────────────────────
// A hardcoded fallback is acceptable for local development but must never
// reach production, where it would let anyone forge a valid session cookie.
const DEV_JWT_SECRET = 'inv-dev-only-secret-not-for-production';
let JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  if (isProduction) {
    fatal(
      'JWT_SECRET is not set and NODE_ENV=production.',
      'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'
    );
  }
  JWT_SECRET = DEV_JWT_SECRET;
  console.warn('⚠️   JWT_SECRET not set — using an insecure development default.');
} else if (isProduction && JWT_SECRET === DEV_JWT_SECRET) {
  fatal('JWT_SECRET is still the development default.', 'Set a unique secret before deploying.');
}

// ── Cross-origin ─────────────────────────────────────────────
// Set CORS_ORIGIN when the frontend is served from a different domain than the
// API (e.g. two separate Vercel projects). Comma-separated for multiple, which
// you will need if you want Vercel preview deployments to work as well as
// production. Leave it unset when both are behind one origin — that is the
// safer arrangement and needs no CORS at all.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))   // tolerate a trailing slash
  .filter(Boolean);

// Any allowed origin means the session cookie travels cross-site, which forces
// SameSite=None — and browsers reject SameSite=None unless Secure is also set,
// so this combination only works over HTTPS.
const isCrossSite = CORS_ORIGINS.length > 0;

if (isProduction && !isCrossSite) {
  console.warn(
    '⚠️   CORS_ORIGIN is not set. This is correct only if the frontend is served\n' +
    '    from this same origin. If it is on its own domain, browsers will block\n' +
    '    every API call.'
  );
}

module.exports = {
  NODE_ENV,
  isProduction,
  PORT: Number(process.env.PORT) || 5001,
  DATABASE_URL,
  JWT_SECRET,
  CORS_ORIGINS,
  isCrossSite,
  // SameSite=None is required to send the cookie cross-site; Lax is kept for
  // the same-origin dev setup, where the Vite proxy makes everything one host.
  COOKIE_SAMESITE: isCrossSite ? 'none' : 'lax',
  COOKIE_SECURE:   isCrossSite || isProduction,
};
