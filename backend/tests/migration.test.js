const test = require('node:test');
const assert = require('node:assert/strict');

const { setupDatabase, resetData, teardownDatabase, query } = require('./helpers/db');
const { applySchemaUpdates } = require('../database/db');

test.before(setupDatabase);
test.after(teardownDatabase);
test.beforeEach(resetData);

async function userColumns() {
  const { rows } = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users'
  `);
  return rows.map(r => r.column_name).sort();
}

/** Put the users table back into its pre-Phase-6 shape: no role column at all. */
async function restorePreRoleSchema() {
  await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_ck`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS role`);
}

test('the migration adds a role column that defaults every existing account to admin', async () => {
  await restorePreRoleSchema();
  const { rows: [user] } = await query(
    `INSERT INTO users (username, password) VALUES ('solo', 'x') RETURNING id`
  );

  await applySchemaUpdates();

  assert.deepEqual(await userColumns(), ['created_at', 'id', 'password', 'role', 'username']);
  const { rows } = await query('SELECT role FROM users WHERE id = $1', [user.id]);
  assert.equal(rows[0].role, 'admin', 'a pre-existing account keeps the access it already had');
});

test('the role CHECK rejects anything outside admin/sub_admin', async () => {
  await assert.rejects(
    query(`INSERT INTO users (username, password, role) VALUES ('bad', 'x', 'owner')`),
    /users_role_ck/
  );
});

test('running the role migration again is a no-op', async () => {
  await restorePreRoleSchema();
  await applySchemaUpdates();
  const columnsAfterFirst = await userColumns();

  await applySchemaUpdates();
  await applySchemaUpdates();

  assert.deepEqual(await userColumns(), columnsAfterFirst);
});

test('the migration runs cleanly against a database that never lacked a role column', async () => {
  // A fresh install: initDB already ran in `before`, so there is nothing to do.
  await applySchemaUpdates();
  assert.deepEqual(await userColumns(), ['created_at', 'id', 'password', 'role', 'username']);
});

/* ── Phase 7 feature flags ────────────────────────────────────────────────── */

test('the feature_key CHECK rejects anything outside the registry', async () => {
  const { rows: [company] } = await query(`INSERT INTO companies (name) VALUES ('Flag Co') RETURNING id`);
  await assert.rejects(
    query(
      `INSERT INTO company_features (company_id, feature_key) VALUES ($1, 'not_a_real_feature')`,
      [company.id]
    ),
    /company_features_key_ck/
  );
});

test('a registered feature key is accepted', async () => {
  const { rows: [company] } = await query(`INSERT INTO companies (name) VALUES ('Flag Co 2') RETURNING id`);
  await query(
    `INSERT INTO company_features (company_id, feature_key) VALUES ($1, 'invoicing')`,
    [company.id]
  );
  const { rows } = await query('SELECT feature_key FROM company_features WHERE company_id = $1', [company.id]);
  assert.deepEqual(rows.map(r => r.feature_key), ['invoicing']);
});

test('running the feature-flags migration again is a no-op', async () => {
  await applySchemaUpdates();
  await applySchemaUpdates();
  // No throw, and the constraint is still exactly one row in the catalogue.
  const { rows } = await query(`
    SELECT conname FROM pg_constraint
    WHERE conname = 'company_features_key_ck_v1'
      AND conrelid = (current_schema() || '.company_features')::regclass
  `);
  assert.equal(rows.length, 1);
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
  for (const col of ['supplier_gstin', 'supplier_name', 'supplier_address', 'supplier_state_code']) {
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

/* ── Phase 4a+4b: numbering series and the tax engine ────────────────────── */

async function restorePreTaxEngineSchema() {
  await query(`
    ALTER TABLE invoices
      DROP COLUMN IF EXISTS place_of_supply_state,
      DROP COLUMN IF EXISTS supplier_scheme,
      DROP COLUMN IF EXISTS cgst_total,
      DROP COLUMN IF EXISTS sgst_total,
      DROP COLUMN IF EXISTS igst_total,
      DROP COLUMN IF EXISTS round_off
  `);
  await query(`
    ALTER TABLE invoice_line_items
      DROP COLUMN IF EXISTS gst_rate,
      DROP COLUMN IF EXISTS cgst_amount,
      DROP COLUMN IF EXISTS sgst_amount,
      DROP COLUMN IF EXISTS igst_amount
  `);
}

test('the migration adds the tax-engine columns to invoices and invoice_line_items', async () => {
  await restorePreTaxEngineSchema();

  await applySchemaUpdates();

  const invoiceCols = await tableColumns('invoices');
  for (const col of ['place_of_supply_state', 'supplier_scheme', 'cgst_total', 'sgst_total', 'igst_total', 'round_off']) {
    assert.ok(invoiceCols.includes(col), `invoices.${col} should exist`);
  }
  const lineCols = await tableColumns('invoice_line_items');
  for (const col of ['gst_rate', 'cgst_amount', 'sgst_amount', 'igst_amount']) {
    assert.ok(lineCols.includes(col), `invoice_line_items.${col} should exist`);
  }
});

test('a company with no GSTIN cannot have tax on an invoice (database CHECK)', async () => {
  await restorePreTaxEngineSchema();
  await applySchemaUpdates();

  const { rows: [company] } = await query(`INSERT INTO companies (name) VALUES ('No GSTIN Tax Co') RETURNING id`);

  await assert.rejects(
    query(
      `INSERT INTO invoices (invoice_no, company_id, customer_name, cgst_total)
       VALUES ('INV-TAX-2', $1, 'Cust', 9)`,
      [company.id]
    ),
    /invoices_tax_requires_gstin_ck/
  );
});

test('a composition-scheme company cannot have tax on an invoice (database CHECK)', async () => {
  await restorePreTaxEngineSchema();
  await applySchemaUpdates();

  const { rows: [company] } = await query(
    `INSERT INTO companies (name, gstin, scheme) VALUES ('Composition Tax Co', '07FGHIJ5678K1Z2', 'composition') RETURNING id`
  );

  await assert.rejects(
    query(
      `INSERT INTO invoices (invoice_no, company_id, customer_name, supplier_gstin, supplier_scheme, sgst_total)
       VALUES ('INV-TAX-3', $1, 'Cust', '07FGHIJ5678K1Z2', 'composition', 9)`,
      [company.id]
    ),
    /invoices_tax_requires_regular_scheme_ck/
  );
});

test('running the tax-engine migration again is a no-op', async () => {
  await restorePreTaxEngineSchema();
  await applySchemaUpdates();
  const first = {
    invoices: await tableColumns('invoices'),
    lineItems: await tableColumns('invoice_line_items'),
  };

  await applySchemaUpdates();
  await applySchemaUpdates();

  assert.deepEqual(await tableColumns('invoices'), first.invoices);
  assert.deepEqual(await tableColumns('invoice_line_items'), first.lineItems);
});

/* ── Phase 8: invoice legal fields (Rule 46) ─────────────────────────────── */

async function restorePreInvoiceLegalFieldsSchema() {
  await query(`ALTER TABLE companies DROP COLUMN IF EXISTS authorized_signatory_name`);
  await query(`
    ALTER TABLE invoices
      DROP COLUMN IF EXISTS customer_address,
      DROP COLUMN IF EXISTS customer_gstin,
      DROP COLUMN IF EXISTS customer_state_code,
      DROP COLUMN IF EXISTS delivery_address,
      DROP COLUMN IF EXISTS reverse_charge,
      DROP COLUMN IF EXISTS supplier_signatory_name
  `);
  await query(`
    ALTER TABLE invoice_line_items
      DROP COLUMN IF EXISTS hsn_sac_code,
      DROP COLUMN IF EXISTS uqc
  `);
}

test('the migration adds Rule 46 fields to companies, invoices and invoice_line_items', async () => {
  await restorePreInvoiceLegalFieldsSchema();

  await applySchemaUpdates();

  const companyCols = await tableColumns('companies');
  assert.ok(companyCols.includes('authorized_signatory_name'));

  const invoiceCols = await tableColumns('invoices');
  for (const col of [
    'customer_address', 'customer_gstin', 'customer_state_code',
    'delivery_address', 'reverse_charge', 'supplier_signatory_name',
  ]) {
    assert.ok(invoiceCols.includes(col), `invoices.${col} should exist`);
  }

  const lineCols = await tableColumns('invoice_line_items');
  assert.ok(lineCols.includes('hsn_sac_code'));
  assert.ok(lineCols.includes('uqc'));
});

test('reverse_charge defaults to false for a pre-existing invoice row', async () => {
  await restorePreInvoiceLegalFieldsSchema();
  const { rows: [company] } = await query(`INSERT INTO companies (name) VALUES ('Legal Fields Co') RETURNING id`);
  const { rows: [invoice] } = await query(
    `INSERT INTO invoices (invoice_no, company_id, customer_name) VALUES ('INV-LF-1', $1, 'Cust') RETURNING id`,
    [company.id]
  );

  await applySchemaUpdates();

  const { rows } = await query('SELECT reverse_charge FROM invoices WHERE id = $1', [invoice.id]);
  assert.equal(rows[0].reverse_charge, false);
});

test('running the invoice-legal-fields migration again is a no-op', async () => {
  await restorePreInvoiceLegalFieldsSchema();
  await applySchemaUpdates();
  const first = {
    companies: await tableColumns('companies'),
    invoices: await tableColumns('invoices'),
    lineItems: await tableColumns('invoice_line_items'),
  };

  await applySchemaUpdates();
  await applySchemaUpdates();

  assert.deepEqual(await tableColumns('companies'), first.companies);
  assert.deepEqual(await tableColumns('invoices'), first.invoices);
  assert.deepEqual(await tableColumns('invoice_line_items'), first.lineItems);
});

/* ── Phase 9: performance indexes ────────────────────────────────────────── */

async function indexNames(table) {
  const { rows } = await query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = $1
  `, [table]);
  return rows.map(r => r.indexname).sort();
}

test('the migration adds the invoice list and line-item lookup indexes', async () => {
  await query('DROP INDEX IF EXISTS idx_invoices_company_created');
  await query('DROP INDEX IF EXISTS idx_line_items_item');

  await applySchemaUpdates();

  assert.ok((await indexNames('invoices')).includes('idx_invoices_company_created'));
  assert.ok((await indexNames('invoice_line_items')).includes('idx_line_items_item'));
});

test('running the performance-indexes migration again is a no-op', async () => {
  await applySchemaUpdates();
  const first = { invoices: await indexNames('invoices'), lineItems: await indexNames('invoice_line_items') };

  await applySchemaUpdates();
  await applySchemaUpdates();

  assert.deepEqual(await indexNames('invoices'), first.invoices);
  assert.deepEqual(await indexNames('invoice_line_items'), first.lineItems);
});
