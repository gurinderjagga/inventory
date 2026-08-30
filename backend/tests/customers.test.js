const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, createCompany, createCustomer } = require('./helpers/fixtures');

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

test('a customer is created for a company', async () => {
  const res = await a.post('/api/customers', {
    company_id: company.id, name: 'Riya Sharma', address: '2 MG Road, Pune',
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Riya Sharma');
  assert.equal(res.body.company_id, company.id);
  assert.equal(res.body.active, true);
});

test('a customer needs a name and a valid company_id', async () => {
  const noName = await a.post('/api/customers', { company_id: company.id, name: '' });
  assert.equal(noName.status, 400);

  const badCompany = await a.post('/api/customers', { company_id: 999999, name: 'X' });
  assert.equal(badCompany.status, 404);
});

test('customers are scoped to their own company', async () => {
  const other = await createCompany('Global Electronics');
  await createCustomer(company.id, { name: 'A' });
  await createCustomer(other.id, { name: 'B' });

  const res = await a.get(`/api/customers/company/${company.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map(c => c.name), ['A']);
});

test('a GSTIN is validated and unique per company', async () => {
  const bad = await a.post('/api/customers', {
    company_id: company.id, name: 'X', gstin: 'not-a-gstin',
  });
  assert.equal(bad.status, 400);

  const gstin = '27ABCDE1234F1Z5';
  const first = await a.post('/api/customers', { company_id: company.id, name: 'A', gstin });
  assert.equal(first.status, 201);

  const dupe = await a.post('/api/customers', { company_id: company.id, name: 'B', gstin });
  assert.equal(dupe.status, 409);

  // The same GSTIN for a different company is not a conflict — scoped per company.
  const other = await createCompany('Global Electronics');
  const elsewhere = await a.post('/api/customers', { company_id: other.id, name: 'C', gstin });
  assert.equal(elsewhere.status, 201);
});

test('a customer can be edited, including archiving it', async () => {
  const created = await createCustomer(company.id, { name: 'Riya Sharma' });

  const edited = await a.put(`/api/customers/${created.id}`, { name: 'Riya Sharma', active: false });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.active, false);

  // Omitting `active` on a later edit preserves it rather than resetting to true.
  const again = await a.put(`/api/customers/${created.id}`, { name: 'Riya S. Sharma' });
  assert.equal(again.body.active, false);
});

test('a customer referenced by an invoice cannot be deleted', async () => {
  const customer = await createCustomer(company.id);
  const { rows: [item] } = await query(
    `INSERT INTO items (company_id, name, quantity, unit_price) VALUES ($1, 'Widget', 10, 5) RETURNING *`,
    [company.id]
  );
  await a.post('/api/invoices', {
    company_id: company.id, customer_id: customer.id, tax_rate: 0,
    line_items: [{ item_id: item.id, quantity: 1, unit_price: 5 }],
  });

  const res = await a.del(`/api/customers/${customer.id}`);
  assert.equal(res.status, 409);
});

test('an unreferenced customer can be deleted', async () => {
  const customer = await createCustomer(company.id);
  const res = await a.del(`/api/customers/${customer.id}`);
  assert.equal(res.status, 200);
});
