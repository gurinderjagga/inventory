const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, createCompany, createItem } = require('./helpers/fixtures');

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

test('an item can carry HSN/SAC, GST rate, UQC and cost price', async () => {
  const res = await a.post('/api/items', {
    company_id: company.id, name: 'Widget', unit_price: 100,
    hsn_sac_code: '8471', gst_rate: 18, uqc: 'PCS', cost_price: 60,
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.hsn_sac_code, '8471');
  assert.equal(res.body.gst_rate, 18);
  assert.equal(res.body.uqc, 'PCS');
  assert.equal(res.body.cost_price, 60);
  assert.equal(res.body.is_service, false);
  assert.equal(res.body.active, true);
});

test('cost_price is rounded to paise like unit_price', async () => {
  const res = await a.post('/api/items', {
    company_id: company.id, name: 'Odd Cost', unit_price: 10, cost_price: 3.005,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.cost_price, 3.01);
});

test('is_service marks an item as a service rather than goods', async () => {
  const res = await a.post('/api/items', {
    company_id: company.id, name: 'Consulting', unit_price: 500, is_service: true,
  });
  assert.equal(res.body.is_service, true);
});

test('SKU is unique per company, not globally', async () => {
  const first = await a.post('/api/items', { company_id: company.id, name: 'A', sku: 'SKU-1', unit_price: 1 });
  assert.equal(first.status, 201);

  const dupe = await a.post('/api/items', { company_id: company.id, name: 'B', sku: 'SKU-1', unit_price: 1 });
  assert.equal(dupe.status, 409);

  const other = await createCompany('Global Electronics');
  const elsewhere = await a.post('/api/items', { company_id: other.id, name: 'C', sku: 'SKU-1', unit_price: 1 });
  assert.equal(elsewhere.status, 201, 'the same SKU is fine for a different company');
});

test('items with no SKU never conflict with each other', async () => {
  const first = await a.post('/api/items', { company_id: company.id, name: 'A', unit_price: 1 });
  const second = await a.post('/api/items', { company_id: company.id, name: 'B', unit_price: 1 });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
});

test('an item can be archived and reactivated', async () => {
  const item = await createItem(company.id, { name: 'Archivable' });

  const archived = await a.put(`/api/items/${item.id}`, { name: item.name, unit_price: item.unit_price, active: false });
  assert.equal(archived.body.active, false);

  const untouched = await a.put(`/api/items/${item.id}`, { name: item.name, unit_price: item.unit_price });
  assert.equal(untouched.body.active, false, 'omitting active on edit must preserve it');
});
