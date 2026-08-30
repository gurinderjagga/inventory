/**
 * tests/helpers/concurrency.js — tools for forcing a specific interleaving.
 *
 * Concurrency bugs do not reproduce by firing two HTTP requests at once: over a
 * real network the second request usually arrives after the first has finished,
 * and the test passes whether or not the locking is correct. These helpers park
 * a request mid-transaction so the dangerous window is guaranteed to be open.
 */
const { Client } = require('pg');
const { query } = require('../../database/db');

/**
 * Take and hold a row lock on an item, from a connection the test controls.
 *
 * Anything that tries to update that row blocks until `release()` is called.
 * Its own connection, deliberately — a client borrowed from the app's pool
 * would be one the routes might also want.
 */
async function lockItemRow(itemId) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT * FROM items WHERE id = $1 FOR UPDATE', [itemId]);

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await client.query('COMMIT').catch(() => {});
      await client.end().catch(() => {});
    },
  };
}

/**
 * Wait until at least `count` backends are blocked waiting on a lock.
 *
 * Polling the server's own view of who is waiting is what makes the test
 * deterministic — a fixed sleep would only be a guess about round-trip time,
 * and would turn into a flaky test on a slower link.
 */
async function waitForBlockedBackends(count, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { rows } = await query(`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
        AND datname = current_database()
    `);
    if (rows[0].n >= count) return;
    await new Promise(r => setTimeout(r, 50));
  }

  throw new Error(
    `Timed out waiting for ${count} blocked backend(s). The interleaving this ` +
    `test depends on did not happen, so its result would not mean anything.`
  );
}

module.exports = { lockItemRow, waitForBlockedBackends };
