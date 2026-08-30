/**
 * The throttles are disabled for every other suite — they are stateful across
 * requests, so leaving them on would make unrelated tests fail depending on how
 * many logins happened to run first. This file turns them back on before the
 * app is loaded and is the only place that exercises them.
 */
process.env.DISABLE_RATE_LIMIT = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase } = require('./helpers/db');
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

/**
 * Each test gets its own client IP. The limiter buckets by IP and its counts
 * live for fifteen minutes, so sharing 127.0.0.1 would mean the first test to
 * exhaust the window decided the outcome of every test after it.
 *
 * This works because server.js sets `trust proxy`, so it reads X-Forwarded-For
 * — which makes these tests a check on that setting too.
 */
let ipCounter = 0;
const fromNewIp = () => agent({ 'X-Forwarded-For': `203.0.113.${++ipCounter}` });

test('repeated failed sign-ins are eventually refused', async () => {
  const a = fromNewIp();

  // The limit is 10 failures per window; the 11th should be turned away
  // without the password even being checked.
  const codes = [];
  for (let i = 0; i < 12; i++) {
    const res = await a.post('/api/auth/login', { username: 'admin', password: 'wrong' });
    codes.push(res.status);
  }

  assert.ok(codes.includes(429), `expected a 429 among ${codes.join(',')}`);
  assert.equal(codes[0], 401, 'the first attempt should be a normal rejection');
  assert.equal(codes.at(-1), 429, 'by the twelfth attempt the door should be shut');

  const blocked = await a.post('/api/auth/login', { username: 'admin', password: 'wrong' });
  assert.match(blocked.body.error, /too many sign-in attempts/i);
});

test('a throttled client is refused even with the correct password', async () => {
  const a = fromNewIp();
  for (let i = 0; i < 12; i++) {
    await a.post('/api/auth/login', { username: 'admin', password: 'wrong' });
  }

  // This is the point of the throttle: guessing must not be rescued by
  // eventually landing on the right answer.
  const res = await a.post('/api/auth/login', { username: 'admin', password: PASSWORD });
  assert.equal(res.status, 429);
});

test('the response carries standard rate-limit headers', async () => {
  const a = fromNewIp();
  const res = await a.post('/api/auth/login', { username: 'admin', password: 'wrong' });
  assert.ok(res.headers.has('ratelimit'), 'expected a RateLimit header for clients to read');
});
