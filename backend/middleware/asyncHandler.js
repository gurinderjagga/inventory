/**
 * middleware/asyncHandler.js
 *
 * Express 4 does not understand promises: if an async handler rejects, the
 * rejection is never forwarded to the error middleware and the request hangs
 * until the client times out. Wrapping every async handler funnels rejections
 * into next(err) so the global error handler can respond.
 *
 *   router.get('/', asyncHandler(async (req, res) => { … }))
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { asyncHandler };
