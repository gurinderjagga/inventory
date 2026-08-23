/**
 * Seeder — creates demo admin user + sample companies and items.
 * Run: node database/seed.js
 */
const bcrypt = require('bcryptjs');
const { initDB, getDB } = require('./db');

async function seed() {
  initDB();
  const db = getDB();

  // ── Admin User ─────────────────────────────────────────────
  const existing = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (!existing) {
    const hash = await bcrypt.hash('admin123', 12);
    db.prepare("INSERT INTO users (username, password) VALUES ('admin', ?)").run(hash);
    console.log('✅ Admin user created  →  admin / admin123');
  } else {
    console.log('ℹ️  Admin user already exists');
  }

  // ── Companies ──────────────────────────────────────────────
  const companies = [
    { name: 'TechCorp Supplies',   email: 'supplies@techcorp.com',  phone: '+1-555-0101', address: '123 Silicon Valley Blvd, San Jose, CA 95101' },
    { name: 'Global Electronics',  email: 'info@globalelec.com',    phone: '+1-555-0202', address: '456 Commerce Street, Austin, TX 78701' },
    { name: 'Office Essentials',   email: 'orders@officeess.com',   phone: '+1-555-0303', address: '789 Business Park, New York, NY 10001' },
  ];

  for (const c of companies) {
    const ex = db.prepare('SELECT id FROM companies WHERE name = ?').get(c.name);
    if (!ex) {
      db.prepare('INSERT INTO companies (name, email, phone, address) VALUES (?, ?, ?, ?)')
        .run(c.name, c.email, c.phone, c.address);
    }
  }
  console.log('✅ Sample companies created');

  // ── Items ──────────────────────────────────────────────────
  const tc = db.prepare("SELECT id FROM companies WHERE name = 'TechCorp Supplies'").get();
  const ge = db.prepare("SELECT id FROM companies WHERE name = 'Global Electronics'").get();
  const oe = db.prepare("SELECT id FROM companies WHERE name = 'Office Essentials'").get();

  const items = [
    // TechCorp Supplies
    { company_id: tc.id, name: 'Laptop Stand (Aluminium)',  sku: 'TC-001', unit: 'pcs',   quantity: 45,  unit_price: 29.99,  low_stock_threshold: 10 },
    { company_id: tc.id, name: 'USB-C Hub 7-in-1',          sku: 'TC-002', unit: 'pcs',   quantity: 8,   unit_price: 49.99,  low_stock_threshold: 15 },
    { company_id: tc.id, name: 'Mechanical Keyboard TKL',   sku: 'TC-003', unit: 'pcs',   quantity: 22,  unit_price: 89.99,  low_stock_threshold: 5  },
    { company_id: tc.id, name: 'Webcam 1080p',              sku: 'TC-004', unit: 'pcs',   quantity: 3,   unit_price: 59.99,  low_stock_threshold: 8  },
    // Global Electronics
    { company_id: ge.id, name: 'HDMI Cable 2m',             sku: 'GE-001', unit: 'pcs',   quantity: 120, unit_price: 9.99,   low_stock_threshold: 20 },
    { company_id: ge.id, name: 'Wireless Mouse Ergonomic',  sku: 'GE-002', unit: 'pcs',   quantity: 7,   unit_price: 34.99,  low_stock_threshold: 10 },
    { company_id: ge.id, name: 'Monitor 24" FHD IPS',       sku: 'GE-003', unit: 'pcs',   quantity: 15,  unit_price: 249.99, low_stock_threshold: 5  },
    { company_id: ge.id, name: 'Power Strip 6-outlet',      sku: 'GE-004', unit: 'pcs',   quantity: 60,  unit_price: 19.99,  low_stock_threshold: 15 },
    // Office Essentials
    { company_id: oe.id, name: 'A4 Copy Paper',             sku: 'OE-001', unit: 'reams', quantity: 200, unit_price: 8.99,   low_stock_threshold: 50 },
    { company_id: oe.id, name: 'Ballpoint Pens (Box of 50)',sku: 'OE-002', unit: 'boxes', quantity: 5,   unit_price: 12.99,  low_stock_threshold: 10 },
    { company_id: oe.id, name: 'Heavy-Duty Stapler',        sku: 'OE-003', unit: 'pcs',   quantity: 30,  unit_price: 14.99,  low_stock_threshold: 8  },
    { company_id: oe.id, name: 'Sticky Notes (3×3, 12pk)', sku: 'OE-004', unit: 'packs', quantity: 9,   unit_price: 7.49,   low_stock_threshold: 12 },
  ];

  const insertItem = db.prepare(`
    INSERT INTO items (company_id, name, sku, unit, quantity, unit_price, low_stock_threshold)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of items) {
    const ex = db.prepare('SELECT id FROM items WHERE sku = ?').get(item.sku);
    if (!ex) {
      insertItem.run(item.company_id, item.name, item.sku, item.unit, item.quantity, item.unit_price, item.low_stock_threshold);
    }
  }
  console.log('✅ Sample items created');

  console.log('\n🎉  Seed complete!');
  console.log('──────────────────────────────');
  console.log('   Login: admin / admin123    ');
  console.log('──────────────────────────────\n');
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
