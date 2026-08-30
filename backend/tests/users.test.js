const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, PASSWORD } = require('./helpers/fixtures');

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

test('accounts are listed without password hashes', async () => {
  const res = await a.get('/api/users');

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].username, 'admin');
  assert.equal(res.body[0].password, undefined, 'a password hash must never leave the API');
  assert.equal(res.body[0].role, undefined);
  assert.equal(res.body[0].company_id, undefined);
});

test('a new account can be created and immediately sign in', async () => {
  const res = await a.post('/api/users', { username: 'warehouse_ops', password: 'ops-password-1' });
  assert.equal(res.status, 201);
  assert.equal(res.body.password, undefined);

  const fresh = agent();
  const me = await fresh.login('warehouse_ops', 'ops-password-1');
  assert.equal(me.username, 'warehouse_ops');
});

test('every account has the same access', async () => {
  await a.post('/api/users', { username: 'warehouse_ops', password: 'ops-password-1' });

  const other = agent();
  await other.login('warehouse_ops', 'ops-password-1');

  // No roles means no gated endpoints — including account management itself.
  for (const path of ['/api/users', '/api/companies', '/api/invoices']) {
    assert.equal((await other.get(path)).status, 200, `${path} should be open to any account`);
  }
  assert.equal((await other.post('/api/companies', { name: 'Made By Ops' })).status, 201);
});

test('a duplicate username is refused', async () => {
  const res = await a.post('/api/users', { username: 'admin', password: 'another-password' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already taken/i);
});

test('a short password is refused on create and on update', async () => {
  assert.equal((await a.post('/api/users', { username: 'shorty', password: 'abc' })).status, 400);

  const made = await a.post('/api/users', { username: 'shorty', password: 'long-enough' });
  const res  = await a.put(`/api/users/${made.body.id}`, { username: 'shorty', password: 'abc' });
  assert.equal(res.status, 400);
});

test('omitting the password on update leaves it unchanged', async () => {
  const made = await a.post('/api/users', { username: 'warehouse_ops', password: 'ops-password-1' });

  const res = await a.put(`/api/users/${made.body.id}`, { username: 'ops_renamed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'ops_renamed');

  const fresh = agent();
  const me = await fresh.login('ops_renamed', 'ops-password-1');
  assert.equal(me.username, 'ops_renamed');
});

test('you cannot delete the account you are signed in with', async () => {
  const me = await a.get('/api/auth/me');

  const res = await a.del(`/api/users/${me.body.id}`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /signed in with/i);

  const { rows } = await query('SELECT id FROM users WHERE id = $1', [me.body.id]);
  assert.equal(rows.length, 1, 'the account must survive');
});

test('the last remaining account cannot be deleted', async () => {
  // Two accounts, signed in as the second, so the self-delete guard is not
  // the thing doing the refusing.
  const doomed = await a.post('/api/users', { username: 'second', password: 'second-password' });
  const other = agent();
  await other.login('second', 'second-password');

  const me = await a.get('/api/auth/me');
  assert.equal((await other.del(`/api/users/${me.body.id}`)).status, 200, 'deleting down to one is allowed');

  // Now only `second` remains, and it is the account making the request.
  const res = await other.del(`/api/users/${doomed.body.id}`);
  assert.equal(res.status, 409);

  const { rows } = await query('SELECT id FROM users');
  assert.equal(rows.length, 1, 'the table must never be emptied');
});

test('deleting an account revokes its session immediately', async () => {
  const made = await a.post('/api/users', { username: 'temp_staff', password: 'temp-password' });
  const temp = agent();
  await temp.login('temp_staff', 'temp-password');
  assert.equal((await temp.get('/api/auth/me')).status, 200);

  await a.del(`/api/users/${made.body.id}`);
  assert.equal((await temp.get('/api/auth/me')).status, 401);
});

test('a username shorter than 3 characters is refused', async () => {
  const res = await a.post('/api/users', { username: 'ab', password: 'long-enough-1' });
  assert.equal(res.status, 400);
});
