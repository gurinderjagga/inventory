/**
 * Unit tests for lib/stockLedger.js's applyMovements() — no database, so this
 * file is fast and deterministic. A live deadlock is inherently a timing
 * race (confirmed by hand while investigating this: forcing Postgres's own
 * detector to fire needs exact millisecond interleaving, which is exactly
 * the kind of thing that's flaky in CI) — what actually GUARANTEES the fix
 * is that lock acquisition order never depends on request payload order in
 * the first place. That's a property of the generated SQL parameters, and
 * it's testable directly against a fake client with no real Postgres
 * connection involved.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { applyMovements } = require('../lib/stockLedger');

/** A fake PoolClient that records every query and always "succeeds". */
function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('UPDATE items')) {
        // Every item id in the update "succeeds" (no insufficient-stock path).
        const itemIds = params[0];
        return { rows: itemIds.map((id) => ({ id })) };
      }
      return { rows: [] };
    },
  };
}

test('item ids are locked in ascending order regardless of request payload order', async () => {
  const client = fakeClient();
  // Deliberately out of order and interleaved with an unrelated item, the
  // way real line items could arrive from a client.
  await applyMovements(client, [
    { itemId: 12, companyId: 1, delta: -1, reason: 'invoice_finalize' },
    { itemId: 5,  companyId: 1, delta: -2, reason: 'invoice_finalize' },
    { itemId: 8,  companyId: 1, delta: -1, reason: 'invoice_finalize' },
  ]);

  const updateCall = client.calls.find((c) => c.text.includes('UPDATE items'));
  assert.ok(updateCall, 'expected a bulk UPDATE');
  assert.deepEqual(updateCall.params[0], [5, 8, 12], 'item ids must be sorted ascending, not request order');
});

test('the reverse request order produces the identical sorted lock order', async () => {
  const client = fakeClient();
  await applyMovements(client, [
    { itemId: 8,  companyId: 1, delta: 1, reason: 'invoice_reversal' },
    { itemId: 12, companyId: 1, delta: 1, reason: 'invoice_reversal' },
    { itemId: 5,  companyId: 1, delta: 1, reason: 'invoice_reversal' },
  ]);

  const updateCall = client.calls.find((c) => c.text.includes('UPDATE items'));
  assert.deepEqual(
    updateCall.params[0], [5, 8, 12],
    'two invoices touching the same items in opposite request order must still acquire locks in the same order'
  );
});

test('duplicate item ids are netted into one entry before sorting', async () => {
  const client = fakeClient();
  await applyMovements(client, [
    { itemId: 12, companyId: 1, delta: -3, reason: 'invoice_finalize' },
    { itemId: 5,  companyId: 1, delta: -1, reason: 'invoice_finalize' },
    { itemId: 12, companyId: 1, delta: -2, reason: 'invoice_finalize' },
  ]);

  const updateCall = client.calls.find((c) => c.text.includes('UPDATE items'));
  assert.deepEqual(updateCall.params[0], [5, 12]);
  const netDeltas = updateCall.params[1];
  assert.equal(Number(netDeltas[updateCall.params[0].indexOf(12)]), -5, 'both lines on item 12 must be summed');
});
