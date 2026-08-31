/**
 * lib/validate.js
 * Input coercion helpers.
 *
 * These exist because `parseFloat(x) || fallback` is wrong in two ways:
 *   - a legitimate 0 is falsy, so it silently becomes the fallback
 *     (sending low_stock_threshold: 0 used to be stored as 10)
 *   - unparseable junk like "abc" becomes NaN, which is also falsy, so bad
 *     input was silently accepted as the fallback instead of being rejected
 */
const { ValidationError } = require('./errors');

/** Treat undefined, null, and '' as "not supplied". */
const isBlank = (v) => v === undefined || v === null || v === '';

/**
 * Coerce a non-negative number, distinguishing "absent" from "invalid".
 *
 * @param {*}      raw      Value from the request body.
 * @param {string} field    Field name, used in the error message.
 * @param {object} [opts]
 * @param {number} [opts.fallback]  Used when raw is absent. Omit to require the field.
 * @returns {number}
 * @throws {ValidationError} if absent with no fallback, unparseable, or negative.
 */
function nonNegativeNumber(raw, field, { fallback } = {}) {
  if (isBlank(raw)) {
    if (fallback === undefined) {
      throw new ValidationError(`${field} is required`);
    }
    return fallback;
  }

  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new ValidationError(`${field} must be a number`);
  }
  if (n < 0) {
    throw new ValidationError(`${field} cannot be negative`);
  }
  return n;
}

/**
 * Coerce a positive integer id, rejecting anything Postgres could not compare
 * against an INTEGER column. Postgres raises 22P02 for `WHERE id = 'abc'`,
 * which would otherwise surface as a 500.
 *
 * @param {*}      raw
 * @param {string} field
 * @returns {number}
 * @throws {ValidationError}
 */
function id(raw, field = 'id') {
  if (isBlank(raw) || !/^\d+$/.test(String(raw).trim())) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return n;
}

/**
 * Trim a required string field.
 * @throws {ValidationError} if missing or blank after trimming.
 */
function requiredString(raw, field) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw new ValidationError(`${field} is required`);
  return s;
}

/** Trim an optional string field, returning null when absent. */
function optionalString(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s || null;
}

const PASSWORD_MIN = 8;
// bcrypt hashes at most 72 bytes and silently ignores the rest, so a longer
// password would give a false sense of strength and, worse, mean two different
// passwords sharing a 72-byte prefix both authenticate. Reject instead.
const PASSWORD_MAX_BYTES = 72;

/**
 * Validate a new password. Length is the only rule — current guidance favours
 * length over composition rules, which mostly push people toward "P@ssw0rd!".
 * @throws {ValidationError}
 */
function password(raw, field = 'Password') {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ValidationError(`${field} is required`);
  }
  if (raw.length < PASSWORD_MIN) {
    throw new ValidationError(`${field} must be at least ${PASSWORD_MIN} characters`);
  }
  if (Buffer.byteLength(raw, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new ValidationError(`${field} must be at most ${PASSWORD_MAX_BYTES} bytes`);
  }
  return raw;
}

/** Validate a username: trimmed, 3–50 chars, no internal whitespace. */
function username(raw, field = 'Username') {
  const s = requiredString(raw, field);
  if (s.length < 3 || s.length > 50) {
    throw new ValidationError(`${field} must be between 3 and 50 characters`);
  }
  if (/\s/.test(s)) {
    throw new ValidationError(`${field} cannot contain spaces`);
  }
  return s;
}

// 2-digit state code + 10-char PAN + 1 entity digit + 'Z' + 1 checksum char.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
// 5 letters, 4 digits, 1 letter.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * Validate an optional GSTIN, uppercased first so a pasted lowercase value
 * isn't rejected on casing alone. Returns null when absent.
 * @throws {ValidationError} if present but not 15 characters in GSTIN shape.
 */
function gstin(raw, field = 'GSTIN') {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!s) return null;
  if (!GSTIN_RE.test(s)) {
    throw new ValidationError(`${field} is not a valid GSTIN`);
  }
  return s;
}

/** Validate an optional PAN. Returns null when absent. */
function pan(raw, field = 'PAN') {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!s) return null;
  if (!PAN_RE.test(s)) {
    throw new ValidationError(`${field} is not a valid PAN`);
  }
  return s;
}

/** Coerce a value to boolean, defaulting when absent (rather than `!!undefined`). */
function boolean(raw, { fallback = false } = {}) {
  if (isBlank(raw)) return fallback;
  return raw === true || raw === 'true';
}

const ROLES = ['admin', 'sub_admin'];

/** Validate a user role, defaulting to 'admin' — the same default the column carries. */
function role(raw, { fallback = 'admin' } = {}) {
  if (isBlank(raw)) return fallback;
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!ROLES.includes(s)) {
    throw new ValidationError(`Role must be one of: ${ROLES.join(', ')}`);
  }
  return s;
}

module.exports = {
  nonNegativeNumber, id, requiredString, optionalString,
  password, username, gstin, pan, boolean, role,
  PASSWORD_MIN,
};
