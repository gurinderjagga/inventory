/**
 * tests/helpers/db.js — schema lifecycle and per-test cleanup.
 *
 * The app's pool is configured by env.js before this module loads, so `query`
 * here is the same connection the routes use, pointed at the test schema.
 */
const { Client } = require('pg');
const { pool, query, initDB, closeDB } = require('../../database/db');
const memoryCache = require('../../lib/memoryCache');

const TEST_SCHEMA = process.env.TEST_SCHEMA || '';

/**
 * Create the schema, if we are using one.
 *
 * A connection whose search_path names a schema that does not exist yet cannot
 * create it — every unqualified CREATE would land nowhere. So this uses its own
 * client with no search_path set.
 */
async function createSchema() {
  if (!TEST_SCHEMA) return;
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.delete('options');

  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
  } finally {
    await client.end();
  }
}

async function dropSchema() {
  if (!TEST_SCHEMA) return;
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.delete('options');

  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  } finally {
    await client.end();
  }
}

/** Create the schema and let the app build its tables inside it. */
async function setupDatabase() {
  await createSchema();
  await initDB();
}

/**
 * Empty every table between tests.
 *
 * RESTART IDENTITY keeps generated ids predictable per test, and CASCADE deals
 * with the foreign keys so the order of this list does not matter.
 */
async function resetData() {
  await query(`
    TRUNCATE TABLE
      stock_movements, user_companies, company_features,
      invoice_number_series, invoice_line_items, invoices, items, companies, users
    RESTART IDENTITY CASCADE
  `);
  // RESTART IDENTITY means the next test's company/user ids can collide with
  // a previous test's — a cached "company 1 has invoicing on" would silently
  // leak into a test where the new company 1 does not.
  memoryCache.clear();
}

/** Tear down: drop the test schema and release the pool. */
async function teardownDatabase() {
  await dropSchema();
  await closeDB();
}

module.exports = { pool, query, setupDatabase, resetData, teardownDatabase, TEST_SCHEMA };
