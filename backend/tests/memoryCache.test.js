/**
 * Unit tests for lib/memoryCache.js — no database, so this file is fast.
 *
 * The property that actually matters for the stampede-protection fix is
 * "concurrent misses trigger exactly one fetch, not one per caller" — that's
 * directly testable with a counting fake fetch function and no real timing
 * race needed, unlike the deadlock fix.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const cache = require('../lib/memoryCache');

test.beforeEach(() => cache.clear());

test('concurrent misses on the same key trigger exactly one fetch', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20)); // simulate a slow query
    return 'the answer';
  };

  const results = await Promise.all([
    cache.getOrFetch('k', 1000, fetchFn),
    cache.getOrFetch('k', 1000, fetchFn),
    cache.getOrFetch('k', 1000, fetchFn),
  ]);

  assert.equal(calls, 1, 'only the first caller should have actually fetched');
  assert.deepEqual(results, ['the answer', 'the answer', 'the answer']);
});

test('a cache hit never calls fetchFn again', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return 'v'; };

  await cache.getOrFetch('k', 1000, fetchFn);
  await cache.getOrFetch('k', 1000, fetchFn);
  await cache.getOrFetch('k', 1000, fetchFn);

  assert.equal(calls, 1);
});

test('a value of false is a real cache hit, not treated as a miss', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return false; };

  const first  = await cache.getOrFetch('k', 1000, fetchFn);
  const second = await cache.getOrFetch('k', 1000, fetchFn);

  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(calls, 1, 'false must not be treated as "not cached"');
});

test('after the TTL expires, the next call fetches again', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return calls; };

  const first = await cache.getOrFetch('k', 10, fetchFn);
  await new Promise((r) => setTimeout(r, 30));
  const second = await cache.getOrFetch('k', 10, fetchFn);

  assert.equal(first, 1);
  assert.equal(second, 2);
});

test('a rejected fetch is not cached, and a later call retries', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    if (calls === 1) throw new Error('transient failure');
    return 'ok';
  };

  await assert.rejects(cache.getOrFetch('k', 1000, fetchFn), /transient failure/);
  const result = await cache.getOrFetch('k', 1000, fetchFn);

  assert.equal(result, 'ok');
  assert.equal(calls, 2, 'a failed fetch must not poison the cache or stay in-flight forever');
});

test('concurrent callers during a failing fetch all see the same rejection', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    throw new Error('boom');
  };

  const attempts = [
    cache.getOrFetch('k', 1000, fetchFn).catch((e) => e),
    cache.getOrFetch('k', 1000, fetchFn).catch((e) => e),
  ];
  const [a, b] = await Promise.all(attempts);

  assert.equal(calls, 1, 'concurrent callers must share the one failing fetch, not each start their own');
  assert.match(a.message, /boom/);
  assert.match(b.message, /boom/);
});

test('del() during an in-flight fetch does not stop the fetch from populating the cache', async () => {
  // Documents the known, pre-existing, TTL-bounded tradeoff rather than
  // asserting a stronger guarantee this cache was never meant to provide.
  let resolveFetch;
  const fetchFn = () => new Promise((r) => { resolveFetch = r; });

  const pending = cache.getOrFetch('k', 1000, fetchFn);
  cache.del('k'); // a write invalidates while the fetch is still in flight
  resolveFetch('stale-ish value');

  const result = await pending;
  assert.equal(result, 'stale-ish value');
  assert.equal(cache.get('k'), 'stale-ish value', 'bounded by ttlMs either way, same as before single-flight existed');
});
