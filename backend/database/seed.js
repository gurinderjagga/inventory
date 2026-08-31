/**
 * Seeder — creates the staff account plus sample companies and items.
 * Run: npm run seed        (from the backend/ directory, or `npm run seed` at the repo root)
 *
 * Every step is idempotent, so re-running it will not duplicate rows.
 */
require('../config');           // load .env before anything touches process.env
const bcrypt = require('bcrypt');
const { query, initDB, closeDB } = require('./db');

const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };

/**
 * Create the default admin account if the users table is empty.
 * Called by the seeder and by server.js on first boot.
 * @returns {Promise<boolean>} true if an account was created.
 */
async function ensureAdminUser() {
  const { rows } = await query('SELECT COUNT(*)::int AS count FROM users');
  if (rows[0].count > 0) return false;

  const hash = await bcrypt.hash(DEFAULT_ADMIN.password, 12);
  await query(
    'INSERT INTO users (username, password) VALUES ($1, $2)',
    [DEFAULT_ADMIN.username, hash]
  );
  return true;
}

const COMPANIES = [
  { name: 'TechCorp Supplies',  email: 'supplies@techcorp.com', phone: '+1-555-0101', address: '123 Silicon Valley Blvd, San Jose, CA 95101' },
  { name: 'Global Electronics', email: 'info@globalelec.com',   phone: '+1-555-0202', address: '456 Commerce Street, Austin, TX 78701' },
  { name: 'Office Essentials',  email: 'orders@officeess.com',  phone: '+1-555-0303', address: '789 Business Park, New York, NY 10001' },
];

const ITEMS = [
  // TechCorp Supplies
  { company: 'TechCorp Supplies',  name: 'Laptop Stand (Aluminium)',   sku: 'TC-001', unit: 'pcs',   quantity: 45,  unit_price: 29.99,  low_stock_threshold: 10 },
  { company: 'TechCorp Supplies',  name: 'USB-C Hub 7-in-1',           sku: 'TC-002', unit: 'pcs',   quantity: 8,   unit_price: 49.99,  low_stock_threshold: 15 },
  { company: 'TechCorp Supplies',  name: 'Mechanical Keyboard TKL',    sku: 'TC-003', unit: 'pcs',   quantity: 22,  unit_price: 89.99,  low_stock_threshold: 5  },
  { company: 'TechCorp Supplies',  name: 'Webcam 1080p',               sku: 'TC-004', unit: 'pcs',   quantity: 3,   unit_price: 59.99,  low_stock_threshold: 8  },
  // Global Electronics
  { company: 'Global Electronics', name: 'HDMI Cable 2m',              sku: 'GE-001', unit: 'pcs',   quantity: 120, unit_price: 9.99,   low_stock_threshold: 20 },
  { company: 'Global Electronics', name: 'Wireless Mouse Ergonomic',   sku: 'GE-002', unit: 'pcs',   quantity: 7,   unit_price: 34.99,  low_stock_threshold: 10 },
  { company: 'Global Electronics', name: 'Monitor 24" FHD IPS',        sku: 'GE-003', unit: 'pcs',   quantity: 15,  unit_price: 249.99, low_stock_threshold: 5  },
  { company: 'Global Electronics', name: 'Power Strip 6-outlet',       sku: 'GE-004', unit: 'pcs',   quantity: 60,  unit_price: 19.99,  low_stock_threshold: 15 },
  // Office Essentials
  { company: 'Office Essentials',  name: 'A4 Copy Paper',              sku: 'OE-001', unit: 'reams', quantity: 200, unit_price: 8.99,   low_stock_threshold: 50 },
  { company: 'Office Essentials',  name: 'Ballpoint Pens (Box of 50)', sku: 'OE-002', unit: 'boxes', quantity: 5,   unit_price: 12.99,  low_stock_threshold: 10 },
  { company: 'Office Essentials',  name: 'Heavy-Duty Stapler',         sku: 'OE-003', unit: 'pcs',   quantity: 30,  unit_price: 14.99,  low_stock_threshold: 8  },
  { company: 'Office Essentials',  name: 'Sticky Notes (3×3, 12pk)',   sku: 'OE-004', unit: 'packs', quantity: 9,   unit_price: 7.49,   low_stock_threshold: 12 },
];

async function seed() {
  await initDB();

  // ── Staff account ──────────────────────────────────────────
  if (await ensureAdminUser()) {
    console.log(`✅ Staff account created  →  ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}`);
  } else {
    console.log('ℹ️  Staff account already exists');
  }

  // ── Companies ──────────────────────────────────────────────
  // ON CONFLICT makes this a no-op when the company is already present.
  for (const c of COMPANIES) {
    await query(
      `INSERT INTO companies (name, email, phone, address)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO NOTHING`,
      [c.name, c.email, c.phone, c.address]
    );
  }
  console.log('✅ Sample companies created');

  // ── Items ──────────────────────────────────────────────────
  // sku has no UNIQUE constraint, so guard with a NOT EXISTS sub-select.
  for (const item of ITEMS) {
    await query(
      `INSERT INTO items (company_id, name, sku, unit, quantity, unit_price, low_stock_threshold)
       SELECT c.id, $2, $3, $4, $5, $6, $7
       FROM companies c
       WHERE c.name = $1
         AND NOT EXISTS (SELECT 1 FROM items WHERE sku = $3)`,
      [item.company, item.name, item.sku, item.unit, item.quantity, item.unit_price, item.low_stock_threshold]
    );
  }
  console.log('✅ Sample items created');

  console.log('\n🎉  Seed complete!');
  console.log('────────────────────────────────────────────────');
  console.log(`   Sign in : ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}`);
  console.log('────────────────────────────────────────────────');
  console.log('   Demo credentials — change before deploying.\n');
}

module.exports = { seed, ensureAdminUser, DEFAULT_ADMIN };

// Only run automatically when invoked directly (`node database/seed.js`),
// not when required by server.js.
if (require.main === module) {
  seed()
    .then(() => closeDB())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Seed failed:', err.message);
      process.exit(1);
    });
}
