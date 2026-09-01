const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, createCompany, createItem, stockOf } = require('./helpers/fixtures');
const { lockItemRow, waitForBlockedBackends } = require('./helpers/concurrency');

let a, company;

test.before(async () => {
  await setupDatabase();
  await startServer();
});
test.after(async () => {
  await stopServer();
  await teardownDatabase();
});
test.beforeEach(async () => {
  await resetData();
  await createUser('admin');
  a = agent();
  await a.login();
  company = await createCompany();
});

async function movementsOf(itemId) {
  const res = await a.get(`/api/items/${itemId}/movements`);
  return res.body;
}

/* ── initial_stock ────────────────────────────────────────────────────── */

test('creating an item with a starting quantity logs an initial_stock movement', async () => {
  const res = await a.post('/api/items', {
    company_id: company.id, name: 'Widget', unit_price: 10, quantity: 25,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.quantity, 25);

  const movements = await movementsOf(res.body.id);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].reason, 'initial_stock');
  assert.equal(Number(movements[0].quantity_delta), 25);
  assert.equal(movements[0].username, 'admin');
});

test('creating an item with no starting quantity logs nothing', async () => {
  const res = await a.post('/api/items', { company_id: company.id, name: 'Widget', unit_price: 10 });
  assert.equal(res.status, 201);
  assert.deepEqual(await movementsOf(res.body.id), []);
});

/* ── editing no longer touches quantity ──────────────────────────────── */

test('editing an item cannot change its quantity', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const res = await a.put(`/api/items/${item.id}`, {
    name: item.name, unit_price: item.unit_price, quantity: 999,
  });
  assert.equal(res.status, 200);
  assert.equal(await stockOf(item.id), 10, 'a stray quantity field on the edit form must be ignored');
});

/* ── stock in / out ──────────────────────────────────────────────────── */

test('stock/out deducts quantity and logs a stock_out movement', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const res = await a.post('/api/stock/out', { company_id: company.id, item_id: item.id, quantity: 2 });

  assert.equal(res.status, 201);
  assert.equal(await stockOf(item.id), 8);

  const movements = await movementsOf(item.id);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].reason, 'stock_out');
  assert.equal(Number(movements[0].quantity_delta), -2);
});

test('insufficient stock is still refused with the same message shape', async () => {
  const item = await createItem(company.id, { quantity: 1 });

  const res = await a.post('/api/stock/out', { company_id: company.id, item_id: item.id, quantity: 5 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Insufficient stock/i);
  assert.equal(await stockOf(item.id), 1);
  assert.deepEqual(await movementsOf(item.id), [], 'a refused dispatch must log nothing');
});

test('stock/in adds quantity and logs a stock_in movement', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const res = await a.post('/api/stock/in', { company_id: company.id, item_id: item.id, quantity: 5 });

  assert.equal(res.status, 201);
  assert.equal(await stockOf(item.id), 15);

  const movements = await movementsOf(item.id);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].reason, 'stock_in');
  assert.equal(Number(movements[0].quantity_delta), 5);
});

/* ── manual adjustment ────────────────────────────────────────────────── */

test('a manual adjustment requires a reason', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const res = await a.post(`/api/items/${item.id}/adjust`, { quantity: 8 });
  assert.equal(res.status, 400);
  assert.equal(await stockOf(item.id), 10);
});

test('a manual adjustment sets the new quantity and logs the reason as a note', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const res = await a.post(`/api/items/${item.id}/adjust`, {
    quantity: 7, reason: 'Physical count found 3 damaged units',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.quantity, 7);

  const movements = await movementsOf(item.id);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].reason, 'manual_adjustment');
  assert.equal(Number(movements[0].quantity_delta), -3);
  assert.equal(movements[0].note, 'Physical count found 3 damaged units');
});

test('adjusting to the same quantity is a no-op, not an error', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const res = await a.post(`/api/items/${item.id}/adjust`, { quantity: 10, reason: 'Recount, no change' });
  assert.equal(res.status, 200);
  assert.deepEqual(await movementsOf(item.id), []);
});

test('an adjustment racing a stock dispatch does not corrupt stock', async () => {
  // Created through the API, not the fixture, so its starting quantity is
  // itself a ledger row — otherwise the assertion below (quantity == sum of
  // movements) would be off by the fixture's untracked baseline.
  const created = await a.post('/api/items', { company_id: company.id, name: 'Raced Widget', unit_price: 10, quantity: 10 });
  const item = created.body;

  const blocker = await lockItemRow(item.id);
  try {
    const dispatch = a.post('/api/stock/out', { company_id: company.id, item_id: item.id, quantity: 2 });
    await waitForBlockedBackends(1);

    const adjust = a.post(`/api/items/${item.id}/adjust`, { quantity: 20, reason: 'Recount' });
    await waitForBlockedBackends(2);

    await blocker.release();

    const [dispatchRes, adjustRes] = await Promise.all([dispatch, adjust]);
    assert.equal(dispatchRes.status, 201);
    assert.equal(adjustRes.status, 200);

    // Whichever order they actually applied in, the ledger and the cached
    // quantity must agree — that is the whole point of doing both inside
    // applyMovement's single UPDATE.
    const { rows } = await query('SELECT quantity FROM items WHERE id = $1', [item.id]);
    const { rows: sum } = await query(
      'SELECT COALESCE(SUM(quantity_delta), 0) AS total FROM stock_movements WHERE item_id = $1',
      [item.id]
    );
    assert.equal(Number(rows[0].quantity), Number(sum[0].total));
  } finally {
    await blocker.release();
  }
});

/* ── deletion ──────────────────────────────────────────────────────────── */

test('an item with only solo movement history can be deleted', async () => {
  const res = await a.post('/api/items', { company_id: company.id, name: 'Widget', unit_price: 10, quantity: 5 });
  const del = await a.del(`/api/items/${res.body.id}`);
  assert.equal(del.status, 200);

  const { rows } = await query('SELECT 1 FROM stock_movements WHERE item_id = $1', [res.body.id]);
  assert.equal(rows.length, 0, 'its movements should cascade away with it');
});

/* ── keyset pagination on GET /api/stock/movements ───────────────────────── */

test('the first page needs no cursor and reports a nextCursor when there is more', async () => {
  const item = await createItem(company.id, { quantity: 100 });
  for (let i = 0; i < 5; i++) {
    await a.post('/api/stock/out', { company_id: company.id, item_id: item.id, quantity: 1 });
  }

  const res = await a.get(`/api/stock/movements?company_id=${company.id}&limit=2`);
  assert.equal(res.status, 200);
  assert.equal(res.body.movements.length, 2);
  assert.equal(res.body.total, 5);
  assert.ok(res.body.nextCursor, 'more rows remain, so a cursor to continue must be present');
});

test('following nextCursor walks the full history exactly once each, newest first', async () => {
  const item = await createItem(company.id, { quantity: 100 });
  // Five distinct, orderable movements.
  for (let i = 1; i <= 5; i++) {
    await a.post('/api/stock/out', { company_id: company.id, item_id: item.id, quantity: i });
  }

  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard++) {
    const url = `/api/stock/movements?company_id=${company.id}&limit=2` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await a.get(url);
    seen.push(...res.body.movements.map(m => Number(m.quantity_delta)));
    cursor = res.body.nextCursor;
    if (!cursor) break;
  }

  // Dispatched 1,2,3,4,5 in that order; newest-first means the last dispatch (-5) comes first.
  assert.deepEqual(seen, [-5, -4, -3, -2, -1]);
});

test('rows sharing the exact same created_at (a bulk insert) are not skipped across a page boundary', async () => {
  // A single multi-row INSERT (as applyMovements does for invoice finalize/
  // reverse) gives every row in the batch the identical timestamp, down to
  // the microsecond. node-postgres parses timestamptz into a JS Date, which
  // only has millisecond resolution, so naively round-tripping the cursor
  // through Date/ISO-string can make ties within one millisecond invisible
  // to the WHERE clause and silently drop rows. Force that exact collision
  // here rather than hoping application timing produces it.
  const item = await createItem(company.id, { quantity: 100 });
  const { rows: ids } = await query(
    `INSERT INTO stock_movements (company_id, item_id, reason, quantity_delta, created_at)
     SELECT $1, $2, 'manual_adjustment', d, NOW()
     FROM unnest(ARRAY[-1, -2, -3]::numeric[]) AS d
     RETURNING id`,
    [company.id, item.id]
  );
  assert.equal(ids.length, 3);

  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard++) {
    const url = `/api/stock/movements?company_id=${company.id}&limit=1` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await a.get(url);
    seen.push(...res.body.movements.map(m => m.id));
    cursor = res.body.nextCursor;
    if (!cursor) break;
  }

  assert.deepEqual(new Set(seen), new Set(ids.map(r => r.id)), 'every row from the batch must be returned exactly once');
});

test('the last page has no nextCursor', async () => {
  const item = await createItem(company.id, { quantity: 100 });
  await a.post('/api/stock/out', { company_id: company.id, item_id: item.id, quantity: 1 });
  await a.post('/api/stock/out', { company_id: company.id, item_id: item.id, quantity: 1 });

  const res = await a.get(`/api/stock/movements?company_id=${company.id}&limit=10`);
  assert.equal(res.body.movements.length, 2);
  assert.equal(res.body.nextCursor, null);
});

test('a malformed cursor is a 400, not a 500 or silently-wrong page', async () => {
  const res = await a.get(`/api/stock/movements?company_id=${company.id}&cursor=not-valid-base64-json`);
  assert.equal(res.status, 400);
});
