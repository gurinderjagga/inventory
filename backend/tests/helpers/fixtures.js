/**
 * tests/helpers/fixtures.js — the small amount of data most tests start from.
 */
const bcrypt = require('bcryptjs');
const { query } = require('../../database/db');

const PASSWORD = 'admin123';

// Hashed once for the whole run. bcrypt at 12 rounds is ~250ms by design, and
// paying that per test would dominate the suite.
let cachedHash;
async function passwordHash() {
  if (!cachedHash) cachedHash = await bcrypt.hash(PASSWORD, 12);
  return cachedHash;
}

/** An account to sign in with. Returns its row. */
async function createUser(username = 'admin', role = 'admin') {
  const { rows } = await query(
    'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id, username, role',
    [username, await passwordHash(), role]
  );
  return rows[0];
}

/** A sub-admin scoped to the given company ids. */
async function createSubAdmin(username, companyIds) {
  const user = await createUser(username, 'sub_admin');
  for (const companyId of companyIds) {
    await query(
      'INSERT INTO user_companies (user_id, company_id) VALUES ($1, $2)',
      [user.id, companyId]
    );
  }
  return user;
}

async function createCompany(name = 'TechCorp Supplies', overrides = {}) {
  const c = {
    email: `${name.toLowerCase().replace(/\W+/g, '')}@example.com`,
    phone: '+91-99999-00000',
    address: '1 Industrial Estate, Pune',
    gstin: null,
    legal_name: null,
    state_code: null,
    pan: null,
    scheme: 'regular',
    einvoice_enabled: false,
    ...overrides,
  };
  const { rows } = await query(
    `INSERT INTO companies (name, email, phone, address, gstin, legal_name, state_code, pan, scheme, einvoice_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [name, c.email, c.phone, c.address, c.gstin, c.legal_name, c.state_code, c.pan, c.scheme, c.einvoice_enabled]
  );
  return rows[0];
}

async function createItem(companyId, overrides = {}) {
  const item = {
    name: 'Webcam 1080p',
    sku: 'TC-004',
    unit: 'pcs',
    quantity: 10,
    unit_price: 59.99,
    low_stock_threshold: 5,
    hsn_sac_code: null,
    is_service: false,
    gst_rate: 0,
    uqc: null,
    cost_price: 0,
    ...overrides,
  };
  const { rows } = await query(
    `INSERT INTO items
       (company_id, name, sku, unit, quantity, unit_price, low_stock_threshold,
        hsn_sac_code, is_service, gst_rate, uqc, cost_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [companyId, item.name, item.sku, item.unit, item.quantity, item.unit_price, item.low_stock_threshold,
      item.hsn_sac_code, item.is_service, item.gst_rate, item.uqc, item.cost_price]
  );
  return rows[0];
}

/** Read an item's current stock — the value most assertions turn on. */
async function stockOf(itemId) {
  const { rows } = await query('SELECT quantity FROM items WHERE id = $1', [itemId]);
  return rows[0] ? Number(rows[0].quantity) : null;
}

module.exports = { PASSWORD, createUser, createSubAdmin, createCompany, createItem, stockOf };
