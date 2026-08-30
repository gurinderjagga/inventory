/**
 * tests/helpers/env.js — preloaded via `node --test --require`.
 *
 * Runs before any application module, because config.js reads DATABASE_URL the
 * moment it is required and everything else requires config.js.
 *
 * ── Where the tests run ──────────────────────────────────────────────────────
 * Point TEST_DATABASE_URL at a throwaway database and that is used as-is.
 *
 * Without one, the tests fall back to the DATABASE_URL from .env but confine
 * themselves to a dedicated schema (`stockflow_test`) via the connection's
 * search_path. Tables are created, truncated and dropped inside that schema and
 * `public` is never touched — the app's SQL is entirely unqualified, so it
 * follows search_path without knowing the difference.
 *
 * That fallback exists because a single hosted database is the common case. It
 * is safe, but it is still a schema in a real database: use TEST_DATABASE_URL
 * (a Neon branch, or a local Postgres) if you would rather it were nowhere near
 * production.
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const TEST_SCHEMA = 'stockflow_test';

function buildTestUrl() {
  if (process.env.TEST_DATABASE_URL) {
    return { url: process.env.TEST_DATABASE_URL, schema: null };
  }

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set — the tests need a Postgres to run against.'
    );
  }

  // Append the search_path option rather than replacing any existing query
  // string, so sslmode and channel_binding survive.
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${TEST_SCHEMA}`);

  // Neon's pooled endpoint (pgbouncer, transaction mode) refuses startup
  // parameters outright — `options` is exactly what it rejects. The direct
  // endpoint is the same database without the pooler in front, and it is the
  // right choice here anyway: the suite opens one short-lived pool, which is
  // not the workload pooling exists for.
  url.hostname = url.hostname.replace('-pooler.', '.');

  return { url: url.toString(), schema: TEST_SCHEMA };
}

const { url, schema } = buildTestUrl();

process.env.DATABASE_URL = url;
process.env.TEST_SCHEMA  = schema || '';

// The schema check must run — it is what creates the tables these tests use.
process.env.SKIP_DB_INIT = 'false';
// Silences the insecure-default warning; these tests never leave the machine.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';
process.env.NODE_ENV   = 'test';
// Rate limiting is verified by its own test, which opts in explicitly. Left on
// everywhere it would make the other suites flaky and order-dependent.
process.env.DISABLE_RATE_LIMIT = process.env.DISABLE_RATE_LIMIT ?? 'true';

module.exports = { TEST_SCHEMA: schema };
