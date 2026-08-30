const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { applySchemaUpdates } = require('../database/db');

test.before(setupDatabase);
test.after(teardownDatabase);
test.beforeEach(resetData);

/**
 * Put the users table back into its pre-migration shape: role and company_id
 * columns, both CHECK constraints, and the index. Mirrors exactly what the
 * removed `applySchemaUpdates` used to build.
 */
async function restoreTenantSchema() {
  await query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER
      REFERENCES companies(id) ON DELETE CASCADE;
  `);
  await query(`UPDATE users SET role = 'admin' WHERE role IS NULL`);
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_ck') THEN
        ALTER TABLE users ADD CONSTRAINT users_role_ck
          CHECK (role IN ('admin', 'company_admin'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_scope_ck') THEN
        ALTER TABLE users ADD CONSTRAINT users_scope_ck CHECK (
          (role = 'admin'         AND company_id IS NULL) OR
          (role = 'company_admin' AND company_id IS NOT NULL)
        );
      END IF;
    END $$;
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)');
}

async function userColumns() {
  const { rows } = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users'
  `);
  return rows.map(r => r.column_name).sort();
}

async function constraintNames() {
  const { rows } = await query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = (current_schema() || '.users')::regclass
  `);
  return rows.map(r => r.conname);
}

test('the migration drops the tenancy columns and the accounts that used them', async () => {
  await restoreTenantSchema();

  const { rows: [company] } = await query(
    `INSERT INTO companies (name) VALUES ('TechCorp Supplies') RETURNING id`
  );
  await query(
    `INSERT INTO users (username, password, role, company_id) VALUES
       ('platform_admin', 'x', 'admin', NULL),
       ('techcorp_admin', 'x', 'company_admin', $1),
       ('global_admin',   'x', 'company_admin', $1)`,
    [company.id]
  );

  await applySchemaUpdates();

  assert.deepEqual(await userColumns(), ['created_at', 'id', 'password', 'username']);

  const names = await constraintNames();
  assert.ok(!names.includes('users_role_ck'), 'users_role_ck should be gone');
  assert.ok(!names.includes('users_scope_ck'), 'users_scope_ck should be gone');

  const { rows } = await query('SELECT username FROM users');
  assert.deepEqual(rows.map(r => r.username), ['platform_admin'],
    'only the tenant logins should have been removed');
});

test('the migration leaves accounts alone when there are no tenant logins', async () => {
  await restoreTenantSchema();
  await query(`INSERT INTO users (username, password, role) VALUES ('solo', 'x', 'admin')`);

  await applySchemaUpdates();

  const { rows } = await query('SELECT username FROM users');
  assert.deepEqual(rows.map(r => r.username), ['solo']);
});

test('running the migration again is a no-op', async () => {
  await restoreTenantSchema();
  await query(`INSERT INTO users (username, password, role) VALUES ('solo', 'x', 'admin')`);

  await applySchemaUpdates();
  const columnsAfterFirst = await userColumns();

  // The guard is what makes every boot after the first cheap and harmless.
  await applySchemaUpdates();
  await applySchemaUpdates();

  assert.deepEqual(await userColumns(), columnsAfterFirst);
  const { rows } = await query('SELECT username FROM users');
  assert.deepEqual(rows.map(r => r.username), ['solo']);
});

test('the migration runs cleanly against a database that never had tenancy', async () => {
  // A fresh install: initDB already ran in `before`, so there is nothing to do.
  await applySchemaUpdates();
  assert.deepEqual(await userColumns(), ['created_at', 'id', 'password', 'username']);
});

/* ── Money columns ─────────────────────────────────────────────────────────── */

async function columnType(table, column) {
  const { rows } = await query(`
    SELECT data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
  `, [table, column]);
  return rows[0];
}

/** Put the money and quantity columns back to DOUBLE PRECISION. */
async function restoreFloatColumns() {
  await query(`
    ALTER TABLE items
      ALTER COLUMN unit_price          TYPE DOUBLE PRECISION,
      ALTER COLUMN quantity            TYPE DOUBLE PRECISION,
      ALTER COLUMN low_stock_threshold TYPE DOUBLE PRECISION
  `);
  await query(`
    ALTER TABLE invoices
      ALTER COLUMN subtotal TYPE DOUBLE PRECISION,
      ALTER COLUMN total    TYPE DOUBLE PRECISION,
      ALTER COLUMN tax_rate TYPE DOUBLE PRECISION
  `);
  await query(`
    ALTER TABLE invoice_line_items
      ALTER COLUMN quantity   TYPE DOUBLE PRECISION,
      ALTER COLUMN unit_price TYPE DOUBLE PRECISION,
      ALTER COLUMN line_total TYPE DOUBLE PRECISION
  `);
}

test('money and quantity columns are converted to NUMERIC', async () => {
  await restoreFloatColumns();
  assert.equal((await columnType('items', 'unit_price')).data_type, 'double precision');

  await applySchemaUpdates();

  const price = await columnType('items', 'unit_price');
  assert.equal(price.data_type, 'numeric');
  assert.equal(price.numeric_precision, 14);
  assert.equal(price.numeric_scale, 2);

  const qty = await columnType('items', 'quantity');
  assert.equal(qty.data_type, 'numeric');
  assert.equal(qty.numeric_scale, 3, 'quantities need 3dp for weight and volume');

  // tax_rate is a percentage, not an amount, so it gets its own narrower type.
  const rate = await columnType('invoices', 'tax_rate');
  assert.equal(rate.data_type, 'numeric');
  assert.equal(rate.numeric_precision, 6);

  for (const col of ['quantity', 'unit_price', 'line_total']) {
    assert.equal((await columnType('invoice_line_items', col)).data_type, 'numeric',
      `invoice_line_items.${col} should be numeric`);
  }
});

test('existing float values are rounded to scale on conversion', async () => {
  await restoreFloatColumns();

  const { rows: [company] } = await query(
    `INSERT INTO companies (name) VALUES ('Drifted Books') RETURNING id`
  );
  // The exact value a double lands on for 3 × 59.99 — what the old code stored.
  await query(
    `INSERT INTO items (company_id, name, unit, quantity, unit_price, low_stock_threshold)
     VALUES ($1, 'Drifted', 'pcs', 10, 179.97000000000003, 5)`,
    [company.id]
  );

  await applySchemaUpdates();

  const { rows } = await query(`SELECT unit_price FROM items WHERE name = 'Drifted'`);
  assert.equal(Number(rows[0].unit_price), 179.97,
    'the stored value should become what it was always displayed as');
});

test('converting the money columns twice is a no-op', async () => {
  await restoreFloatColumns();
  await applySchemaUpdates();
  const first = await columnType('items', 'unit_price');

  await applySchemaUpdates();
  await applySchemaUpdates();

  assert.deepEqual(await columnType('items', 'unit_price'), first);
});

/* ── Phase 2 GST fields ────────────────────────────────────────────────────── */

/** Put companies/items/invoices back into their pre-Phase-2 shape. */
async function restorePreGstSchema() {
  await query(`
    ALTER TABLE companies
      DROP COLUMN IF EXISTS gstin,
      DROP COLUMN IF EXISTS legal_name,
      DROP COLUMN IF EXISTS state_code,
      DROP COLUMN IF EXISTS pan,
      DROP COLUMN IF EXISTS scheme,
      DROP COLUMN IF EXISTS einvoice_enabled,
      DROP COLUMN IF EXISTS active,
      DROP COLUMN IF EXISTS updated_at
  `);
  await query(`
    ALTER TABLE items
      DROP COLUMN IF EXISTS hsn_sac_code,
      DROP COLUMN IF EXISTS is_service,
      DROP COLUMN IF EXISTS gst_rate,
      DROP COLUMN IF EXISTS uqc,
      DROP COLUMN IF EXISTS cost_price,
      DROP COLUMN IF EXISTS active,
      DROP COLUMN IF EXISTS updated_at
  `);
  await query(`
    ALTER TABLE invoices
      DROP COLUMN IF EXISTS supplier_gstin,
      DROP COLUMN IF EXISTS supplier_name,
      DROP COLUMN IF EXISTS supplier_address,
      DROP COLUMN IF EXISTS supplier_state_code,
      DROP COLUMN IF EXISTS customer_id,
      DROP COLUMN IF EXISTS updated_at
  `);
  // The composite unique constraint depends on the columns above only indirectly,
  // but restore the pre-Phase-2 global uniqueness too so the swap is exercised.
  await query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_company_invoice_no_key') THEN
        ALTER TABLE invoices DROP CONSTRAINT invoices_company_invoice_no_key;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_invoice_no_key') THEN
        ALTER TABLE invoices ADD CONSTRAINT invoices_invoice_no_key UNIQUE (invoice_no);
      END IF;
    END $$;
  `);
}

async function tableColumns(table) {
  const { rows } = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = $1
  `, [table]);
  return rows.map(r => r.column_name).sort();
}

test('the migration adds GST fields to companies, items and invoices', async () => {
  await restorePreGstSchema();

  await applySchemaUpdates();

  const companyCols = await tableColumns('companies');
  for (const col of ['gstin', 'legal_name', 'state_code', 'pan', 'scheme', 'einvoice_enabled', 'active']) {
    assert.ok(companyCols.includes(col), `companies.${col} should exist`);
  }

  const itemCols = await tableColumns('items');
  for (const col of ['hsn_sac_code', 'is_service', 'gst_rate', 'uqc', 'cost_price', 'active']) {
    assert.ok(itemCols.includes(col), `items.${col} should exist`);
  }

  const invoiceCols = await tableColumns('invoices');
  for (const col of ['supplier_gstin', 'supplier_name', 'supplier_address', 'supplier_state_code', 'customer_id']) {
    assert.ok(invoiceCols.includes(col), `invoices.${col} should exist`);
  }
});

test('invoice_no can repeat across companies after the migration', async () => {
  await restorePreGstSchema();
  await applySchemaUpdates();

  const { rows: [a] } = await query(`INSERT INTO companies (name) VALUES ('Company A') RETURNING id`);
  const { rows: [b] } = await query(`INSERT INTO companies (name) VALUES ('Company B') RETURNING id`);

  await query(
    `INSERT INTO invoices (invoice_no, company_id, customer_name) VALUES ('INV-0001', $1, 'Cust A')`,
    [a.id]
  );
  // Same invoice_no, different company — must succeed under the new composite constraint.
  await query(
    `INSERT INTO invoices (invoice_no, company_id, customer_name) VALUES ('INV-0001', $1, 'Cust B')`,
    [b.id]
  );

  const { rows } = await query('SELECT COUNT(*)::int AS n FROM invoices');
  assert.equal(rows[0].n, 2);
});

test('a company cannot charge tax without a supplier GSTIN (database CHECK)', async () => {
  await restorePreGstSchema();
  await applySchemaUpdates();

  const { rows: [company] } = await query(`INSERT INTO companies (name) VALUES ('No GSTIN Co') RETURNING id`);

  await assert.rejects(
    query(
      `INSERT INTO invoices (invoice_no, company_id, customer_name, tax_rate)
       VALUES ('INV-TAX-1', $1, 'Cust', 18)`,
      [company.id]
    ),
    /invoices_supplier_gstin_ck/
  );
});

test('running the GST-fields migration again is a no-op', async () => {
  await restorePreGstSchema();
  await applySchemaUpdates();
  const first = {
    companies: await tableColumns('companies'),
    items: await tableColumns('items'),
    invoices: await tableColumns('invoices'),
  };

  await applySchemaUpdates();
  await applySchemaUpdates();

  assert.deepEqual(await tableColumns('companies'), first.companies);
  assert.deepEqual(await tableColumns('items'), first.items);
  assert.deepEqual(await tableColumns('invoices'), first.invoices);
});

/* ── Phase 3 stock ledger ─────────────────────────────────────────────────── */

test('the reason CHECK rejects anything outside the known set', async () => {
  const { rows: [company] } = await query(`INSERT INTO companies (name) VALUES ('Ledger Co') RETURNING id`);
  const { rows: [item] } = await query(
    `INSERT INTO items (company_id, name, quantity, unit_price) VALUES ($1, 'Widget', 5, 10) RETURNING id`,
    [company.id]
  );

  await assert.rejects(
    query(
      `INSERT INTO stock_movements (item_id, company_id, quantity_delta, reason)
       VALUES ($1, $2, 5, 'made_up_reason')`,
      [item.id, company.id]
    ),
    /stock_movements_reason_ck/
  );
});

test('an item with pre-existing stock gets a backfilled opening-balance movement', async () => {
  const { rows: [company] } = await query(`INSERT INTO companies (name) VALUES ('Backfill Co') RETURNING id`);
  // Inserted directly, bypassing the ledger — exactly the pre-Phase-3 shape
  // this backfill exists to reconcile.
  const { rows: [item] } = await query(
    `INSERT INTO items (company_id, name, quantity, unit_price) VALUES ($1, 'Legacy Stock', 42, 5) RETURNING id`,
    [company.id]
  );
  const { rows: [zeroItem] } = await query(
    `INSERT INTO items (company_id, name, quantity, unit_price) VALUES ($1, 'Never Stocked', 0, 5) RETURNING id`,
    [company.id]
  );

  await applySchemaUpdates();

  const { rows: movements } = await query(
    `SELECT reason, quantity_delta FROM stock_movements WHERE item_id = $1`, [item.id]
  );
  assert.equal(movements.length, 1);
  assert.equal(movements[0].reason, 'initial_stock');
  assert.equal(Number(movements[0].quantity_delta), 42);

  const { rows: zeroMovements } = await query(
    `SELECT 1 FROM stock_movements WHERE item_id = $1`, [zeroItem.id]
  );
  assert.equal(zeroMovements.length, 0, 'a never-stocked item gets no backfilled movement');
});

test('the opening-balance backfill never runs twice for the same item', async () => {
  const { rows: [company] } = await query(`INSERT INTO companies (name) VALUES ('Backfill Co 2') RETURNING id`);
  const { rows: [item] } = await query(
    `INSERT INTO items (company_id, name, quantity, unit_price) VALUES ($1, 'Legacy Stock', 10, 5) RETURNING id`,
    [company.id]
  );

  await applySchemaUpdates();
  await applySchemaUpdates();
  await applySchemaUpdates();

  const { rows: movements } = await query(
    `SELECT 1 FROM stock_movements WHERE item_id = $1`, [item.id]
  );
  assert.equal(movements.length, 1, 'running the migration again must not duplicate the backfill');
});

test('an item that already has a movement is left alone by the backfill', async () => {
  // Mirrors an item created through the app after this phase shipped: it
  // already carries its own `initial_stock` row from creation, so the
  // table-wide backfill query must not add a second one just because it also
  // ran on the same boot as some unrelated item's very first migration.
  const { rows: [company] } = await query(`INSERT INTO companies (name) VALUES ('Backfill Co 3') RETURNING id`);
  const { rows: [item] } = await query(
    `INSERT INTO items (company_id, name, quantity, unit_price) VALUES ($1, 'Fresh Item', 7, 5) RETURNING id`,
    [company.id]
  );
  await query(
    `INSERT INTO stock_movements (item_id, company_id, quantity_delta, reason)
     VALUES ($1, $2, 7, 'initial_stock')`,
    [item.id, company.id]
  );

  await applySchemaUpdates();

  const { rows: movements } = await query(
    `SELECT 1 FROM stock_movements WHERE item_id = $1`, [item.id]
  );
  assert.equal(movements.length, 1);
});
