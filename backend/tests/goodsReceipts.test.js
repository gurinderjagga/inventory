const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, createCompany, createItem, stockOf } = require('./helpers/fixtures');

let a, company, item;

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
  item = await createItem(company.id, { quantity: 5 });
});

async function createReceipt(overrides = {}) {
  return a.post('/api/goods-receipts', {
    company_id: company.id, supplier_name: 'Acme Wholesale',
    line_items: [{ item_id: item.id, quantity: 20, unit_cost: 3.5 }],
    ...overrides,
  });
}

test('a goods receipt increases stock and is recorded', async () => {
  const res = await createReceipt();
  assert.equal(res.status, 201);
  assert.equal(res.body.supplier_name, 'Acme Wholesale');
  assert.equal(await stockOf(item.id), 25);

  const detail = await a.get(`/api/goods-receipts/${res.body.id}`);
  assert.equal(detail.body.line_items.length, 1);
  assert.equal(detail.body.line_items[0].item_name, item.name);
  assert.equal(Number(detail.body.line_items[0].unit_cost), 3.5);
});

test('a multi-line receipt updates every item', async () => {
  const second = await createItem(company.id, { name: 'Second Item', sku: 'SEC-1', quantity: 0 });
  const res = await createReceipt({
    line_items: [
      { item_id: item.id, quantity: 10, unit_cost: 2 },
      { item_id: second.id, quantity: 4, unit_cost: 15 },
    ],
  });
  assert.equal(res.status, 201);
  assert.equal(await stockOf(item.id), 15);
  assert.equal(await stockOf(second.id), 4);
});

test('a goods receipt produces a movement referencing itself', async () => {
  const res = await createReceipt();
  const movements = await a.get(`/api/items/${item.id}/movements`);
  assert.equal(movements.body.length, 1);
  assert.equal(movements.body[0].reason, 'goods_received');
  assert.equal(Number(movements.body[0].quantity_delta), 20);
  assert.equal(movements.body[0].goods_receipt_supplier, 'Acme Wholesale');
});

test('a receipt cannot credit another company\'s stock', async () => {
  const other = await createCompany('Other Co');
  const res = await a.post('/api/goods-receipts', {
    company_id: other.id, supplier_name: 'Acme Wholesale',
    line_items: [{ item_id: item.id, quantity: 5, unit_cost: 1 }],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /No such item/i);
});

test('a receipt needs a company, a supplier and at least one line', async () => {
  const noCompany = await a.post('/api/goods-receipts', {
    supplier_name: 'X', line_items: [{ item_id: item.id, quantity: 1, unit_cost: 1 }],
  });
  assert.equal(noCompany.status, 400);

  const noSupplier = await createReceipt({ supplier_name: '' });
  assert.equal(noSupplier.status, 400);

  const noLines = await createReceipt({ line_items: [] });
  assert.equal(noLines.status, 400);
});

test('an item referenced by a goods receipt cannot be deleted', async () => {
  await createReceipt();
  const res = await a.del(`/api/items/${item.id}`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /goods receipt/i);
});

test('deleting a company with goods receipts is refused', async () => {
  await createReceipt();
  const res = await a.del(`/api/companies/${company.id}`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /goods receipt/i);
});
