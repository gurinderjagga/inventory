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

/* ── invoice finalize / reverse ──────────────────────────────────────── */

async function createDraft(item, overrides = {}) {
  return a.post('/api/invoices', {
    company_id: company.id, customer_name: 'Riya Sharma', tax_rate: 0,
    line_items: [{ item_id: item.id, quantity: 2, unit_price: 10 }],
    ...overrides,
  });
}

test('finalizing logs an invoice_finalize movement', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const draft = await createDraft(item);
  const finalized = await a.post(`/api/invoices/${draft.body.id}/finalize`);

  const movements = await movementsOf(item.id);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].reason, 'invoice_finalize');
  assert.equal(Number(movements[0].quantity_delta), -2);
  // The invoice_no changes at finalize (Phase 4a assigns the real sequential
  // number here), so the movement's reference is checked against the
  // finalized invoice, not the draft's placeholder.
  assert.equal(movements[0].invoice_no, finalized.body.invoice.invoice_no);
});

test('insufficient stock is still refused with the same message shape', async () => {
  const item = await createItem(company.id, { quantity: 1 });
  const draft = await createDraft(item, { line_items: [{ item_id: item.id, quantity: 5, unit_price: 10 }] });

  const res = await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Insufficient stock/i);
  assert.match(res.body.error, /Available: 1/);
  assert.match(res.body.error, /Requested: 5/);
  assert.equal(await stockOf(item.id), 1);
  assert.deepEqual(await movementsOf(item.id), [], 'a refused finalize must log nothing');
});

test('reversing a finalized invoice restores stock through the ledger', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const draft = await createDraft(item);
  await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.equal(await stockOf(item.id), 8);

  const res = await a.post(`/api/invoices/${draft.body.id}/reverse`);
  assert.equal(res.status, 200);
  assert.equal(res.body.invoice.status, 'reversed');
  assert.equal(await stockOf(item.id), 10);

  const movements = await movementsOf(item.id);
  assert.equal(movements.length, 2);
  assert.equal(movements[0].reason, 'invoice_reversal');
  assert.equal(Number(movements[0].quantity_delta), 2);
});

test('a draft cannot be reversed', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const draft = await createDraft(item);
  const res = await a.post(`/api/invoices/${draft.body.id}/reverse`);
  assert.equal(res.status, 409);
});

test('an invoice cannot be reversed twice', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const draft = await createDraft(item);
  await a.post(`/api/invoices/${draft.body.id}/finalize`);
  await a.post(`/api/invoices/${draft.body.id}/reverse`);

  const again = await a.post(`/api/invoices/${draft.body.id}/reverse`);
  assert.equal(again.status, 409);
  assert.equal(await stockOf(item.id), 10, 'a refused reversal must not double-restore');
});

test('a reversed invoice can be neither edited nor deleted', async () => {
  const item = await createItem(company.id, { quantity: 10 });
  const draft = await createDraft(item);
  await a.post(`/api/invoices/${draft.body.id}/finalize`);
  await a.post(`/api/invoices/${draft.body.id}/reverse`);

  const edit = await a.put(`/api/invoices/${draft.body.id}`, {
    customer_name: 'Nope', tax_rate: 0,
    line_items: [{ item_id: item.id, quantity: 1, unit_price: 1 }],
  });
  assert.equal(edit.status, 409);

  const del = await a.del(`/api/invoices/${draft.body.id}`);
  assert.equal(del.status, 409);
  assert.match(del.body.error, /financial record/i);
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

test('an adjustment racing a finalize does not corrupt stock', async () => {
  // Created through the API, not the fixture, so its starting quantity is
  // itself a ledger row — otherwise the assertion below (quantity == sum of
  // movements) would be off by the fixture's untracked baseline.
  const created = await a.post('/api/items', { company_id: company.id, name: 'Raced Widget', unit_price: 10, quantity: 10 });
  const item = created.body;
  const draft = await createDraft(item);

  const blocker = await lockItemRow(item.id);
  try {
    const finalize = a.post(`/api/invoices/${draft.body.id}/finalize`);
    await waitForBlockedBackends(1);

    const adjust = a.post(`/api/items/${item.id}/adjust`, { quantity: 20, reason: 'Recount' });
    await waitForBlockedBackends(2);

    await blocker.release();

    const [finalizeRes, adjustRes] = await Promise.all([finalize, adjust]);
    assert.equal(finalizeRes.status, 200);
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
