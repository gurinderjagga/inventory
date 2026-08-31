const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, createSubAdmin, createCompany, PASSWORD } = require('./helpers/fixtures');

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

test('the registry lists invoicing', async () => {
  const res = await a.get('/api/features');
  assert.equal(res.status, 200);
  assert.ok(res.body.some(f => f.key === 'invoicing' && f.label));
});

test('a company starts with no features enabled', async () => {
  const res = await a.get(`/api/features/company/${company.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('an admin can enable and disable a feature for a company', async () => {
  const on = await a.post(`/api/features/company/${company.id}/invoicing`);
  assert.equal(on.status, 201);
  assert.deepEqual((await a.get(`/api/features/company/${company.id}`)).body, ['invoicing']);

  const off = await a.del(`/api/features/company/${company.id}/invoicing`);
  assert.equal(off.status, 200);
  assert.deepEqual((await a.get(`/api/features/company/${company.id}`)).body, []);
});

test('enabling twice is a no-op, not an error', async () => {
  assert.equal((await a.post(`/api/features/company/${company.id}/invoicing`)).status, 201);
  assert.equal((await a.post(`/api/features/company/${company.id}/invoicing`)).status, 201);
  assert.deepEqual((await a.get(`/api/features/company/${company.id}`)).body, ['invoicing']);
});

test('an unknown feature key is rejected', async () => {
  const res = await a.post(`/api/features/company/${company.id}/not_a_real_feature`);
  assert.equal(res.status, 400);
});

test('the database rejects an unknown feature key too', async () => {
  await assert.rejects(
    query(
      `INSERT INTO company_features (company_id, feature_key) VALUES ($1, 'not_a_real_feature')`,
      [company.id]
    ),
    /company_features_key_ck/
  );
});

test('toggling a feature is admin-only', async () => {
  const sub = await createSubAdmin('sub_ops', [company.id]);
  const subAgent = agent();
  await subAgent.login('sub_ops', PASSWORD);

  assert.equal((await subAgent.post(`/api/features/company/${company.id}/invoicing`)).status, 403);
  assert.equal((await subAgent.del(`/api/features/company/${company.id}/invoicing`)).status, 403);
  void sub;
});

test('a sub-admin can still see which features are enabled for its own company', async () => {
  await a.post(`/api/features/company/${company.id}/invoicing`);
  await createSubAdmin('sub_ops', [company.id]);
  const subAgent = agent();
  await subAgent.login('sub_ops', PASSWORD);

  const res = await subAgent.get(`/api/features/company/${company.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, ['invoicing']);
});

test('a sub-admin cannot see features for a company it is not assigned to', async () => {
  const other = await createCompany('Other Co');
  await createSubAdmin('sub_ops', [company.id]);
  const subAgent = agent();
  await subAgent.login('sub_ops', PASSWORD);

  const res = await subAgent.get(`/api/features/company/${other.id}`);
  assert.equal(res.status, 404);
});

test('deleting a company drops its feature rows', async () => {
  await a.post(`/api/features/company/${company.id}/invoicing`);
  await a.del(`/api/companies/${company.id}`);

  const { rows } = await query('SELECT 1 FROM company_features WHERE company_id = $1', [company.id]);
  assert.equal(rows.length, 0);
});

/* ── enabled/:key — reachability check for gating global UI ─────────────── */

test('enabled/:key is false for an admin when no company has the feature on', async () => {
  const res = await a.get('/api/features/enabled/invoicing');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
});

test('enabled/:key is true for an admin once any company has the feature on', async () => {
  await a.post(`/api/features/company/${company.id}/invoicing`);
  const res = await a.get('/api/features/enabled/invoicing');
  assert.equal(res.body.enabled, true);
});

test('enabled/:key only counts a sub-admin\'s own assigned companies', async () => {
  const other = await createCompany('Other Co');
  await a.post(`/api/features/company/${other.id}/invoicing`); // enabled, but NOT assigned to sub_ops
  await createSubAdmin('sub_ops', [company.id]);
  const subAgent = agent();
  await subAgent.login('sub_ops', PASSWORD);

  assert.equal((await subAgent.get('/api/features/enabled/invoicing')).body.enabled, false);

  await a.post(`/api/features/company/${company.id}/invoicing`); // now enabled on sub_ops's own company
  assert.equal((await subAgent.get('/api/features/enabled/invoicing')).body.enabled, true);
});

test('enabled/:key is false for a sub-admin with no assigned companies at all', async () => {
  await createSubAdmin('sub_ops', []);
  const subAgent = agent();
  await subAgent.login('sub_ops', PASSWORD);

  assert.equal((await subAgent.get('/api/features/enabled/invoicing')).body.enabled, false);
});

test('enabled/:key rejects an unknown feature key', async () => {
  const res = await a.get('/api/features/enabled/not_a_real_feature');
  assert.equal(res.status, 400);
});
