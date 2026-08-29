/**
 * Vercel serverless entry point.
 *
 * Vercel's Node runtime turns each file under `api/` into a function and hands
 * it (req, res) — the same signature an Express app already has, so the app can
 * be re-exported directly.
 *
 * `backend/vercel.json` rewrites every path here, and Vercel preserves the
 * original URL, so Express still sees `/api/auth/login` and its routers match
 * exactly as they do locally.
 *
 * server.js only calls listen() when run directly, so requiring it here starts
 * no socket — Vercel owns that.
 */
module.exports = require('../server.js');
