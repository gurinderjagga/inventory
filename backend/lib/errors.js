/**
 * lib/errors.js
 * Typed errors that carry an HTTP status.
 *
 * Routes throw these instead of building a response inline; the global error
 * handler in server.js turns anything with a `status` into that response and
 * treats everything else as an unexpected 500. That keeps "expected" failures
 * (bad input, conflicts) from being reported as server faults, and stops a
 * genuine crash from being mislabelled as a validation problem.
 */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name   = this.constructor.name;
    this.status = status;
  }
}

/** 400 — the request itself is malformed or fails a business rule. */
class ValidationError extends HttpError {
  constructor(message) { super(400, message); }
}

/**
 * 403 — the caller is authenticated but lacks the privilege.
 *
 * Use this only where the *existence* of the thing is not itself a secret,
 * e.g. "creating companies requires a platform admin". For a resource that
 * belongs to another tenant, throw NotFoundError instead: answering 403 would
 * confirm the record exists.
 */
class ForbiddenError extends HttpError {
  constructor(message = 'You do not have permission to do that') { super(403, message); }
}

/** 404 — the addressed resource does not exist, or is not the caller's. */
class NotFoundError extends HttpError {
  constructor(message = 'Not found') { super(404, message); }
}

/** 409 — the request is well formed but conflicts with current state. */
class ConflictError extends HttpError {
  constructor(message) { super(409, message); }
}

module.exports = { HttpError, ValidationError, ForbiddenError, NotFoundError, ConflictError };
