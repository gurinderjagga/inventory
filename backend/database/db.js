/**
 * database/db.js
 * Uses Node.js built-in `node:sqlite` (stable in Node 24).
 * No native compilation needed — zero extra dependencies.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'inventory.db');

let db;

function getDB() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    // Enable WAL mode (better concurrent read performance)
    db.exec("PRAGMA journal_mode = WAL");
    // Enforce foreign key constraints
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}

/**
 * Run a function inside a SQLite transaction.
 * Automatically COMMITs on success, ROLLBACKs on any thrown error.
 * The thrown error is re-thrown so callers can handle it.
 *
 * @param {Function} fn  Synchronous function to run inside the transaction.
 * @returns {*} Whatever fn() returns.
 */
function runTransaction(fn) {
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

function initDB() {
  const database = getDB();

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companies (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE NOT NULL,
      email      TEXT,
      phone      TEXT,
      address    TEXT,
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS items (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name                TEXT NOT NULL,
      sku                 TEXT,
      unit                TEXT DEFAULT 'pcs',
      quantity            REAL NOT NULL DEFAULT 0,
      low_stock_threshold REAL DEFAULT 10,
      unit_price          REAL NOT NULL DEFAULT 0,
      created_at          DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no     TEXT UNIQUE NOT NULL,
      company_id     INTEGER NOT NULL REFERENCES companies(id),
      customer_name  TEXT NOT NULL,
      customer_email TEXT,
      notes          TEXT,
      subtotal       REAL NOT NULL DEFAULT 0,
      tax_rate       REAL NOT NULL DEFAULT 0,
      total          REAL NOT NULL DEFAULT 0,
      status         TEXT DEFAULT 'draft',
      created_at     DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      item_id     INTEGER NOT NULL REFERENCES items(id),
      item_name   TEXT NOT NULL,
      quantity    REAL NOT NULL,
      unit_price  REAL NOT NULL,
      line_total  REAL NOT NULL
    );
  `);

  console.log('✅ Database schema initialized (node:sqlite built-in)');
  return database;
}

module.exports = { getDB, initDB, runTransaction };
