/**
 * tests/helpers/client.js — a minimal HTTP client for the tests.
 *
 * Deliberately hand-rolled rather than pulling in supertest: all this needs to
 * do is bind the exported Express app to an ephemeral port, speak JSON, and
 * remember a session cookie. Node has had `fetch` built in for several releases,
 * so that is a few dozen lines and no new dependency in the tree.
 */
const app = require('../../server');

let server;
let baseUrl;

/** Bind the app to an ephemeral port. Returns the base URL. */
async function startServer() {
  if (server) return baseUrl;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
  baseUrl = null;
}

/**
 * A client that carries its own cookie jar, so two agents in one test act as
 * two independent browsers.
 *
 * `defaultHeaders` is how the rate-limit tests give themselves a distinct
 * X-Forwarded-For: the limiter buckets by IP, and every request here otherwise
 * arrives from 127.0.0.1, which would leak one test's tally into the next.
 */
function agent(defaultHeaders = {}) {
  const jar = new Map();

  function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function storeCookies(res) {
    // getSetCookie keeps multiple Set-Cookie headers separate; a plain get()
    // would join them with commas and split Expires dates down the middle.
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name  = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      // An expired cookie is a deletion — clearCookie sends exactly this.
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function request(method, path, body, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...defaultHeaders, ...extraHeaders };
    const cookies = cookieHeader();
    if (cookies) headers.Cookie = cookies;

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    storeCookies(res);

    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

    return { status: res.status, body: parsed, headers: res.headers };
  }

  return {
    get:  (p, h) => request('GET', p, undefined, h),
    post: (p, b) => request('POST', p, b),
    put:  (p, b) => request('PUT', p, b),
    del:  (p)    => request('DELETE', p),
    /** Sign in and keep the session for subsequent calls. */
    async login(username = 'admin', password = 'admin123') {
      const res = await this.post('/api/auth/login', { username, password });
      if (res.status !== 200) {
        throw new Error(`Login failed (${res.status}): ${JSON.stringify(res.body)}`);
      }
      return res.body;
    },
    get cookies() { return new Map(jar); },
  };
}

module.exports = { startServer, stopServer, agent };
