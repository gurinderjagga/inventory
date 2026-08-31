const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { startServer, stopServer, agent } = require('./helpers/client');
const { createUser, PASSWORD } = require('./helpers/fixtures');

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
});

test('signing in returns the account and sets a session cookie', async () => {
  const a = agent();
  const res = await a.post('/api/auth/login', { username: 'admin', password: PASSWORD });

  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'admin');
  assert.ok(res.body.id, 'expected an id in the response');
  assert.ok(a.cookies.has('token'), 'expected a token cookie');

  // createUser('admin') defaults to the admin role.
  assert.equal(res.body.role, 'admin');
  assert.equal(res.body.company_id, undefined);
  assert.equal(res.body.password, undefined);
});

test('the session cookie is HttpOnly', async () => {
  const a = agent();
  const res = await a.post('/api/auth/login', { username: 'admin', password: PASSWORD });
  const cookie = res.headers.getSetCookie().find(c => c.startsWith('token='));
  assert.match(cookie, /HttpOnly/i);
});

test('a wrong password is rejected, and says nothing about which half was wrong', async () => {
  const a = agent();
  const res = await a.post('/api/auth/login', { username: 'admin', password: 'not-the-password' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid username or password');
  assert.ok(!a.cookies.has('token'));
});

test('an unknown username gets the same answer as a wrong password', async () => {
  const a = agent();
  const res = await a.post('/api/auth/login', { username: 'nobody', password: PASSWORD });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid username or password');
});

test('/me reflects the signed-in account, and 401s without a session', async () => {
  const anon = agent();
  assert.equal((await anon.get('/api/auth/me')).status, 401);

  const a = agent();
  await a.login();
  const me = await a.get('/api/auth/me');

  assert.equal(me.status, 200);
  assert.equal(me.body.username, 'admin');
  assert.equal(me.body.role, 'admin');
});

test('signing out clears the session', async () => {
  const a = agent();
  await a.login();
  assert.equal((await a.get('/api/auth/me')).status, 200);

  const out = await a.post('/api/auth/logout');
  assert.equal(out.status, 200);
  assert.equal((await a.get('/api/auth/me')).status, 401);
});

test('a deleted account cannot keep using its cookie', async () => {
  const a = agent();
  const me = await a.login();
  await query('DELETE FROM users WHERE id = $1', [me.id]);

  // The token is still cryptographically valid — the account lookup on every
  // request is what makes the deletion take effect immediately.
  const res = await a.get('/api/auth/me');
  assert.equal(res.status, 401);
});

test('changing a password requires the current one, and the new one then works', async () => {
  const a = agent();
  await a.login();

  const wrong = await a.post('/api/auth/change-password', {
    current_password: 'wrong', new_password: 'brand-new-password',
  });
  assert.equal(wrong.status, 400);

  const ok = await a.post('/api/auth/change-password', {
    current_password: PASSWORD, new_password: 'brand-new-password',
  });
  assert.equal(ok.status, 200);

  const fresh = agent();
  assert.equal((await fresh.post('/api/auth/login', { username: 'admin', password: PASSWORD })).status, 401);
  assert.equal((await fresh.post('/api/auth/login', { username: 'admin', password: 'brand-new-password' })).status, 200);
});

test('a password under 8 characters is refused', async () => {
  const a = agent();
  await a.login();
  const res = await a.post('/api/auth/change-password', {
    current_password: PASSWORD, new_password: 'short',
  });
  assert.equal(res.status, 400);
});

test('protected endpoints reject an unauthenticated caller', async () => {
  const anon = agent();
  for (const path of ['/api/users', '/api/companies', '/api/stock/movements?company_id=1', '/api/items/company/1']) {
    assert.equal((await anon.get(path)).status, 401, `${path} should require a session`);
  }
});
