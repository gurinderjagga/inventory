/**
 * middleware/rateLimit.js — throttles for the endpoints worth guessing at.
 *
 * There is no self-signup and no password reset, so `/api/auth/login` is the
 * only door in. Before this, it accepted guesses as fast as the network could
 * carry them.
 *
 * Counting is per IP and in-process. On a single long-running server that is
 * exactly right. On serverless each instance keeps its own tally, so the
 * effective limit is looser than the number below — still a hard ceiling on any
 * one instance, but move the store to Postgres or Redis if the deployment fans
 * out widely.
 */
const rateLimit = require('express-rate-limit');

// Set by the test bootstrap. Limits are stateful across requests, which would
// make unrelated suites fail depending on how many logins ran before them; the
// throttles have a test of their own that opts back in.
const DISABLED = process.env.DISABLE_RATE_LIMIT === 'true';

/** A limiter that disappears entirely when disabled, rather than half-applying. */
function make(options) {
  if (DISABLED) return (req, res, next) => next();
  return rateLimit({
    standardHeaders: 'draft-7',   // RateLimit-* headers
    legacyHeaders: false,
    // Count only failures: someone signing in correctly many times is a shared
    // office, not an attack, and locking them out helps nobody.
    skipSuccessfulRequests: true,
    handler: (req, res) => {
      res.status(429).json({ error: options.message });
    },
    ...options,
  });
}

/**
 * Sign-in attempts. Ten failures per IP per fifteen minutes leaves ordinary
 * mistyping alone — a person who has forgotten which password they used gets
 * several tries — while making online guessing useless.
 */
const loginLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
});

/**
 * Password changes. Requires the current password, so it is a guessing surface
 * too — and one reachable with a stolen cookie.
 */
const passwordChangeLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many password change attempts. Please wait a few minutes and try again.',
});

/**
 * Everything else, as a backstop against scraping and runaway clients. Generous
 * enough that normal use never notices: a busy session is tens of requests.
 */
const apiLimiter = make({
  windowMs: 60 * 1000,
  limit: 300,
  skipSuccessfulRequests: false,
  message: 'Too many requests. Please slow down and try again shortly.',
});

module.exports = { loginLimiter, passwordChangeLimiter, apiLimiter };
