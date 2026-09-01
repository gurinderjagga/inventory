/**
 * lib/logger.js
 * One structured JSON line per call, to stdout/stderr — no external
 * dependency, since this app's whole logging surface is small enough not to
 * need one: a request-timing line per response, a slow-query line per query
 * over threshold, and a labeled line for the two existing error sites.
 *
 * JSON lines rather than formatted text so a real log aggregator (or just
 * `grep`/`jq` on the raw output) can filter on `event`, `code`, or
 * `durationMs` without parsing free text.
 */
function log(level, event, fields = {}) {
  const line = { level, event, time: new Date().toISOString(), ...fields };
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

module.exports = {
  info:  (event, fields) => log('info', event, fields),
  warn:  (event, fields) => log('warn', event, fields),
  error: (event, fields) => log('error', event, fields),
};
