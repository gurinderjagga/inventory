/**
 * lib/httpCache.js — conditional GET for JSON responses.
 *
 * Different lever from lib/memoryCache.js: that one skips the database
 * query; this one skips sending the response body at all when the browser
 * already has the current one, saving the transfer and the client's JSON
 * parse — worthwhile even on a cache hit, since the payload still has to
 * cross the network and get parsed either way without this.
 *
 * `private` (never `public`) because every response this touches is scoped
 * to the signed-in caller's own visibility — an admin sees more than a
 * sub-admin does — so a shared cache must never serve one caller's response
 * to another. `no-cache` does NOT mean "don't cache": it means the browser
 * may keep the body, but must revalidate with the server (send If-None-Match)
 * before using it — which is exactly what makes the 304 path below reachable.
 */
const generateEtag = require('etag');

/**
 * Send JSON, answering 304 with no body when the client's If-None-Match
 * already matches the current ETag.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {*} body
 */
function sendCached(req, res, body) {
  const payload = JSON.stringify(body);
  const tag = generateEtag(payload);

  res.set('Cache-Control', 'private, no-cache');
  res.set('ETag', tag);

  if (req.headers['if-none-match'] === tag) {
    res.status(304).end();
    return;
  }
  res.type('application/json').send(payload);
}

module.exports = { sendCached };
