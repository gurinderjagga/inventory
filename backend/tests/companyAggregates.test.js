const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, createCompany } = require('./helpers/fixtures');

/**
 * companies.item_count / low_stock_count / stock_value used to be a live
 * LEFT JOIN + GROUP BY over `items`, recomputed on every 15s cache miss —
 * finding #5 of the scalability audit. They're now maintained columns,
 * recomputed (not incremented) at every call site that can change them:
 * lib/stockLedger.js's applyMovement/applyMovements for anything
 * quantity-driven, and routes/items.js's create/update/delete directly.
 *
 * These tests go through the real HTTP routes, not the createItem() fixture
 * (which inserts directly via SQL) — the whole point is to exercise the
 * code paths that keep the maintained columns in sync, which a direct SQL
 * insert bypasses entirely, same as it would bypass the stock ledger itself.
 */

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

async function companyRow() {
  const res = await a.get(`/api/companies/${company.id}`);
  return res.body;
}

/** Ground truth, queried independently of the maintained columns under test. */
async function liveAggregate() {
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS item_count,
       COALESCE(SUM(CASE WHEN quantity <= low_stock_threshold THEN 1 ELSE 0 END), 0)::int AS low_stock_count,
       COALESCE(SUM(quantity * unit_price), 0) AS stock_value
     FROM items WHERE company_id = $1`,
    [company.id]
  );
  return rows[0];
}

async function assertMatchesGroundTruth() {
  const [stored, live] = await Promise.all([companyRow(), liveAggregate()]);
  assert.equal(stored.item_count, live.item_count, 'item_count drifted from the truth');
  assert.equal(stored.low_stock_count, live.low_stock_count, 'low_stock_count drifted from the truth');
  assert.equal(Number(stored.stock_value), Number(live.stock_value), 'stock_value drifted from the truth');
}

test('a new company starts at zero', async () => {
  const c = await companyRow();
  assert.equal(c.item_count, 0);
  assert.equal(c.low_stock_count, 0);
  assert.equal(Number(c.stock_value), 0);
});

test('creating an item with a starting quantity updates all three aggregates', async () => {
  const res = await a.post('/api/items', {
    company_id: company.id, name: 'Widget', unit_price: 50, quantity: 10, low_stock_threshold: 5,
  });
  assert.equal(res.status, 201);

  const c = await companyRow();
  assert.equal(c.item_count, 1);
  assert.equal(c.low_stock_count, 0, 'quantity 10 > threshold 5, not low stock');
  assert.equal(Number(c.stock_value), 500);
});

test('creating an item with NO starting quantity still updates item_count', async () => {
  await a.post('/api/items', { company_id: company.id, name: 'Empty Shelf', unit_price: 20 });
  const c = await companyRow();
  assert.equal(c.item_count, 1, 'applyMovement is never called on this path — item_count must not depend on it');
  assert.equal(Number(c.stock_value), 0);
});

test('a low-stock item is counted the moment it is created', async () => {
  await a.post('/api/items', {
    company_id: company.id, name: 'Scarce Thing', unit_price: 10, quantity: 2, low_stock_threshold: 5,
  });
  const c = await companyRow();
  assert.equal(c.low_stock_count, 1);
});

test('changing unit_price alone (no quantity change) updates stock_value', async () => {
  const created = await a.post('/api/items', {
    company_id: company.id, name: 'Widget', unit_price: 50, quantity: 10,
  });
  await a.put(`/api/items/${created.body.id}`, { name: 'Widget', unit_price: 75, low_stock_threshold: 10 });

  const c = await companyRow();
  assert.equal(Number(c.stock_value), 750, 'quantity(10) * new price(75)');
});

test('changing low_stock_threshold alone can move an item in or out of low_stock_count', async () => {
  const created = await a.post('/api/items', {
    company_id: company.id, name: 'Widget', unit_price: 10, quantity: 8, low_stock_threshold: 5,
  });
  assert.equal((await companyRow()).low_stock_count, 0);

  // Raising the threshold above the current quantity pushes it into low stock
  // without a single unit moving.
  await a.put(`/api/items/${created.body.id}`, { name: 'Widget', unit_price: 10, low_stock_threshold: 20 });
  assert.equal((await companyRow()).low_stock_count, 1);
});

test('stock in / stock out track stock_value through the ledger', async () => {
  const created = await a.post('/api/items', {
    company_id: company.id, name: 'Widget', unit_price: 10, quantity: 10,
  });
  const item = created.body;

  await a.post('/api/stock/movements', { company_id: company.id, item_id: item.id, mode: 'in', quantity: 5, reference_no: 'PO-1' });
  assert.equal(Number((await companyRow()).stock_value), 150, '15 units * 10');

  await a.post('/api/stock/movements', { company_id: company.id, item_id: item.id, mode: 'out', quantity: 8, reference_no: 'JOB-1' });
  assert.equal(Number((await companyRow()).stock_value), 70, '7 units * 10');
});

test('a manual adjustment updates the aggregates like any other quantity change', async () => {
  const created = await a.post('/api/items', {
    company_id: company.id, name: 'Widget', unit_price: 10, quantity: 10, low_stock_threshold: 5,
  });
  await a.post('/api/stock/movements', { company_id: company.id, item_id: created.body.id, mode: 'count', quantity: 2, note: 'Physical count' });

  const c = await companyRow();
  assert.equal(Number(c.stock_value), 20);
  assert.equal(c.low_stock_count, 1, 'adjusted quantity 2 is now under threshold 5');
});

test('deleting an item removes its contribution to every aggregate', async () => {
  const keep = await a.post('/api/items', {
    company_id: company.id, name: 'Keep', unit_price: 10, quantity: 10, low_stock_threshold: 5,
  });
  const gone = await a.post('/api/items', {
    company_id: company.id, name: 'Gone', unit_price: 100, quantity: 3, low_stock_threshold: 5,
  });
  assert.equal((await companyRow()).item_count, 2);

  const del = await a.del(`/api/items/${gone.body.id}`);
  assert.equal(del.status, 200);

  const c = await companyRow();
  assert.equal(c.item_count, 1);
  assert.equal(c.low_stock_count, 0, "the deleted item was the only low-stock one");
  assert.equal(Number(c.stock_value), 100, 'only the kept item (10 * 10) remains');
});

test('invoice finalize and reverse track stock_value through applyMovements, the bulk path', async () => {
  const created = await a.post('/api/items', {
    company_id: company.id, name: 'Widget', unit_price: 10, quantity: 20, low_stock_threshold: 5,
  });
  const item = created.body;
  await query(
    `INSERT INTO company_features (company_id, feature_key) VALUES ($1, 'invoicing') ON CONFLICT DO NOTHING`,
    [company.id]
  );

  const draft = await a.post('/api/invoices', {
    company_id: company.id,
    customer_name: 'Riya Sharma',
    customer_address: '2 Market Road, Mumbai',
    line_items: [{ item_id: item.id, quantity: 6, unit_price: 10 }],
  });
  assert.equal(draft.status, 201);
  assert.equal(Number((await companyRow()).stock_value), 200, 'a draft does not touch stock');

  const finalized = await a.post(`/api/invoices/${draft.body.id}/finalize`);
  assert.equal(finalized.status, 200);
  assert.equal(Number((await companyRow()).stock_value), 140, '14 units left * 10 after finalize deducts 6');

  const reversed = await a.post(`/api/invoices/${draft.body.id}/reverse`);
  assert.equal(reversed.status, 200);
  assert.equal(Number((await companyRow()).stock_value), 200, 'reverse restores the 6 units');
});

test('a long sequence of mutations never drifts from a live recompute of the truth', async () => {
  const one = await a.post('/api/items', {
    company_id: company.id, name: 'One', unit_price: 12, quantity: 20, low_stock_threshold: 5,
  });
  const two = await a.post('/api/items', {
    company_id: company.id, name: 'Two', unit_price: 8, quantity: 3, low_stock_threshold: 10,
  });
  await assertMatchesGroundTruth();

  await a.post('/api/stock/movements', { company_id: company.id, item_id: one.body.id, mode: 'in', quantity: 5, reference_no: 'PO-1' });
  await a.post('/api/stock/movements', { company_id: company.id, item_id: two.body.id, mode: 'out', quantity: 1, reference_no: 'JOB-1' });
  await a.put(`/api/items/${one.body.id}`, { name: 'One', unit_price: 15, low_stock_threshold: 5 });
  await a.post('/api/stock/movements', { company_id: company.id, item_id: two.body.id, mode: 'count', quantity: 0, note: 'Sold out' });
  await assertMatchesGroundTruth();

  const three = await a.post('/api/items', { company_id: company.id, name: 'Three', unit_price: 50, quantity: 1, low_stock_threshold: 10 });
  await a.del(`/api/items/${one.body.id}`);
  await assertMatchesGroundTruth();
  assert.ok(three.body.id, 'sanity: the third item really was created');
});
