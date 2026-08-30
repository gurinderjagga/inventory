const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, createCompany } = require('./helpers/fixtures');

let a;

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
});

test('a company can be created with GST fields', async () => {
  const res = await a.post('/api/companies', {
    name: 'Registered Traders',
    gstin: '27ABCDE1234F1Z5',
    legal_name: 'Registered Traders Pvt Ltd',
    state_code: '27',
    pan: 'ABCDE1234F',
    scheme: 'composition',
    einvoice_enabled: true,
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.gstin, '27ABCDE1234F1Z5');
  assert.equal(res.body.scheme, 'composition');
  assert.equal(res.body.einvoice_enabled, true);
  assert.equal(res.body.active, true);
});

test('a company with no GSTIN is exactly as valid — GSTIN is optional', async () => {
  const res = await a.post('/api/companies', { name: 'Local Traders' });
  assert.equal(res.status, 201);
  assert.equal(res.body.gstin, null);
  assert.equal(res.body.scheme, 'regular', 'the default scheme applies even without a GSTIN');
});

test('a malformed GSTIN or PAN is rejected', async () => {
  const badGstin = await a.post('/api/companies', { name: 'X', gstin: 'not-a-gstin' });
  assert.equal(badGstin.status, 400);

  const badPan = await a.post('/api/companies', { name: 'Y', pan: 'not-a-pan' });
  assert.equal(badPan.status, 400);
});

test('an invalid scheme is rejected', async () => {
  const res = await a.post('/api/companies', { name: 'X', scheme: 'flat-rate' });
  assert.equal(res.status, 400);
});

test('GSTIN is unique across companies', async () => {
  const gstin = '27ABCDE1234F1Z5';
  const first = await a.post('/api/companies', { name: 'A', gstin });
  assert.equal(first.status, 201);

  const dupe = await a.post('/api/companies', { name: 'B', gstin });
  assert.equal(dupe.status, 409);
  assert.match(dupe.body.error, /GSTIN/i);
});

test('two companies can both have no GSTIN', async () => {
  const first = await a.post('/api/companies', { name: 'A' });
  const second = await a.post('/api/companies', { name: 'B' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
});

test('a company can be archived and reactivated', async () => {
  const company = await createCompany('Archivable Co');

  const archived = await a.put(`/api/companies/${company.id}`, { name: company.name, active: false });
  assert.equal(archived.body.active, false);

  const untouched = await a.put(`/api/companies/${company.id}`, { name: company.name });
  assert.equal(untouched.body.active, false, 'omitting active on edit must preserve it');

  const reactivated = await a.put(`/api/companies/${company.id}`, { name: company.name, active: true });
  assert.equal(reactivated.body.active, true);
});
