/**
 * database/db.js
 * Postgres data layer, backed by a `pg` connection pool.
 *
 * Everything here is async — unlike the previous synchronous node:sqlite
 * implementation, every caller must await.
 */
const { Pool, types } = require('pg');
const { DATABASE_URL } = require('../config');
const { FEATURE_KEYS } = require('../lib/features');
const logger = require('../lib/logger');

// Any single query at or above this is logged as slow — a P95 creeping
// upward on a paginated endpoint (or a lock wait inside a transaction) is
// otherwise invisible until someone reruns a benchmark by hand.
const SLOW_QUERY_MS = 500;

/** Log `text` as a slow query if it took at least SLOW_QUERY_MS. */
function logIfSlow(text, startedAt) {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (durationMs >= SLOW_QUERY_MS) {
    logger.warn('slow_query', {
      durationMs: Math.round(durationMs),
      // Collapsed whitespace and capped length: these are multi-line
      // template-literal SQL strings, not meant for a one-line log record.
      sql: text.replace(/\s+/g, ' ').trim().slice(0, 300),
    });
  }
}

/** Run `queryFn(text, params)`, timing it, regardless of outcome. */
async function timed(queryFn, text, params) {
  const startedAt = process.hrtime.bigint();
  try {
    return await queryFn(text, params);
  } finally {
    logIfSlow(text, startedAt);
  }
}

/**
 * Return NUMERIC columns as JavaScript numbers rather than strings.
 *
 * `pg` hands back NUMERIC as a string by default, and for good reason: NUMERIC
 * is arbitrary precision and a double is not. Overriding that needs an argument,
 * so here it is.
 *
 * The values are bounded. NUMERIC(14,2) tops out just under 10^12; scaled to
 * paise that is 10^14, and a double represents every integer exactly up to
 * 9×10^15. Quantities at NUMERIC(14,3) scale to 10^15 — inside the same bound.
 * So every value this schema can hold survives the round trip exactly.
 *
 * What it buys is a stable contract. JSON has no decimal type, so an amount
 * leaves as either a number or a string, and strings quietly break comparison
 * in the client: `"10.000" <= "5.000"` is TRUE, because two strings compare
 * lexicographically. That would have marked well-stocked items as low.
 *
 * Exactness where it actually matters — computing totals and tax — is handled
 * by lib/money.js, which does its arithmetic in Decimal and hands back strings
 * for storage. Nothing depends on a double to be correct.
 */
const PG_NUMERIC_OID = 1700;
types.setTypeParser(PG_NUMERIC_OID, (value) => (value === null ? null : Number(value)));

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Neon closes idle connections server-side; keep the pool modest and
  // recycle idle clients so we never hand out a dead socket.
  //
  // max: 20 — this connects through Neon's pooled (PgBouncer) endpoint, not
  // a direct one, and was raised from the original conservative 5 after
  // measuring this account directly: 60 concurrent queries against the real
  // database went from 3.2s at max=5 to 1.2s at max=40, with no connection
  // errors anywhere in that range. 20 captures most of that gain (a fixed
  // workload ran 2.16x faster) while leaving headroom below where the gains
  // leveled off, without assuming a specific account limit that was never
  // actually documented anywhere in this codebase.
  //
  // connectionTimeoutMillis: 5_000 — fail fast rather than queuing requests
  // for 10 s when the database is unreachable. A quick 503 is more useful
  // than a client hanging for ten seconds then timing out anyway.
  //
  // allowExitOnIdle: true — lets Node exit cleanly once all clients are
  // released, without the process needing to call pool.end() first. Useful
  // for scripts (seed.js) and prevents orphaned processes in development.
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
});


// A pooled client can fail while idle (network blip, Neon scale-to-zero).
// Without a listener this reaches 'uncaughtException' and kills the process.
pool.on('error', (err) => {
  logger.error('pg_pool_error', { message: err.message, code: err.code });
});

/**
 * Run a single query outside any transaction.
 * @param {string} text  SQL with $1, $2… placeholders.
 * @param {Array}  params
 * @returns {Promise<import('pg').QueryResult>}
 */
function query(text, params) {
  return timed((t, p) => pool.query(t, p), text, params);
}

/**
 * Run a function inside a Postgres transaction.
 * COMMITs on success, ROLLBACKs on any thrown error, and always releases the
 * client. The error is re-thrown so callers can map it to a response.
 *
 * The callback receives the dedicated client — every statement inside the
 * transaction MUST use it, not the pool, or it will run on a separate
 * connection outside the transaction.
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 * @returns {Promise<any>} Whatever fn() resolves to.
 */
async function runTransaction(fn) {
  const client = await pool.connect();
  // fn() only ever calls `.query()` on what it's handed — a plain object
  // forwarding to the real client, timed the same way the top-level query()
  // is, rather than mutating the pooled client itself (which would still be
  // wrapped, doubly, the next time this same client is checked out).
  const timedClient = { query: (text, params) => timed((t, p) => client.query(t, p), text, params) };
  try {
    await client.query('BEGIN');
    const result = await fn(timedClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Create the schema if it does not already exist. Safe to run on every boot. */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS companies (
      id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name       TEXT UNIQUE NOT NULL,
      email      TEXT,
      phone      TEXT,
      address    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Phase 6: sub-admin -> company assignments. Only meaningful for
    -- role = 'sub_admin' — an admin's access is implicit (every company) and
    -- has no rows here, so granting an admin access to N companies is not N
    -- inserts. Both foreign keys cascade: deleting either side of the
    -- relationship just drops the assignment, not the user or the company.
    CREATE TABLE IF NOT EXISTS user_companies (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, company_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_companies_company ON user_companies(company_id);

    -- Phase 7: per-company feature toggles. A row's mere presence means "on" —
    -- there is no enabled=false row, so turning a feature off is a DELETE, not
    -- an UPDATE, and a company with nothing here has nothing enabled. feature_key
    -- is a closed set (see the CHECK added in addFeatureFlags below) so a typo
    -- fails loudly at write time instead of silently never matching a real key.
    CREATE TABLE IF NOT EXISTS company_features (
      company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      feature_key TEXT NOT NULL,
      enabled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, feature_key)
    );

    CREATE TABLE IF NOT EXISTS items (
      id                  INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name                TEXT NOT NULL,
      sku                 TEXT,
      unit                TEXT NOT NULL DEFAULT 'pcs',
      -- NUMERIC, never DOUBLE PRECISION: see exactMoneyColumns() below for why.
      quantity            NUMERIC(14,3) NOT NULL DEFAULT 0,
      low_stock_threshold NUMERIC(14,3) NOT NULL DEFAULT 10,
      unit_price          NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      invoice_no     TEXT UNIQUE NOT NULL,
      company_id     INTEGER NOT NULL REFERENCES companies(id),
      customer_name  TEXT NOT NULL,
      customer_email TEXT,
      notes          TEXT,
      subtotal       NUMERIC(14,2) NOT NULL DEFAULT 0,
      tax_rate       NUMERIC(6,3)  NOT NULL DEFAULT 0,
      total          NUMERIC(14,2) NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'draft',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      item_id    INTEGER NOT NULL REFERENCES items(id),
      item_name  TEXT NOT NULL,
      quantity   NUMERIC(14,3) NOT NULL,
      unit_price NUMERIC(14,2) NOT NULL,
      line_total NUMERIC(14,2) NOT NULL
    );



    -- Phase 3: the append-only stock ledger. items.quantity stays the column
    -- everything reads, but it is now a maintained CACHE of this table's sum,
    -- not the truth itself — every mutation to it happens alongside a row
    -- here, in the same transaction (see lib/stockLedger.js).
    CREATE TABLE IF NOT EXISTS stock_movements (
      id               INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      item_id          INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      quantity_delta   NUMERIC(14,3) NOT NULL,
      reason           TEXT NOT NULL,
      invoice_id       INTEGER REFERENCES invoices(id),
      note             TEXT,
      user_id          INTEGER REFERENCES users(id),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Phase 4a: one sequential counter per (company, document type, financial
    -- year) — a company's invoices, and later its credit/debit notes, each
    -- get their own series. Allocated by a single atomic upsert in
    -- routes/invoices.js, not read here directly.
    CREATE TABLE IF NOT EXISTS invoice_number_series (
      company_id     INTEGER NOT NULL REFERENCES companies(id),
      document_type  TEXT NOT NULL,
      financial_year TEXT NOT NULL,
      next_number    INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (company_id, document_type, financial_year)
    );

    CREATE INDEX IF NOT EXISTS idx_items_company           ON items(company_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_company        ON invoices(company_id);
    CREATE INDEX IF NOT EXISTS idx_line_items_invoice      ON invoice_line_items(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_item    ON stock_movements(item_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_company ON stock_movements(company_id, created_at);
  `);

  await applySchemaUpdates();

  console.log('✅ Database schema ready (Postgres)');
}

/**
 * Schema changes applied after the base tables exist.
 *
 * Every statement is idempotent and safe to run on every boot. This is a
 * deliberate stopgap, not a migration system: once schema changes get more
 * involved than this, move to a real tool (node-pg-migrate or similar) rather
 * than growing this function.
 */
async function applySchemaUpdates() {
  await exactMoneyColumns();
  await addGstFields();
  await addStockLedger();
  await addTaxEngine();
  await upgradeReasonConstraint();
  await addRoleAndCompanyScoping();
  await addFeatureFlags();
  await addInvoiceLegalFields();
  await addPerformanceIndexes();
  await addCompanyAggregateColumns();
  await addInvoiceIdempotencyKey();
  await addStockMovementReference();
}

/**
 * Move money and quantity off DOUBLE PRECISION.
 *
 * Binary floating point cannot represent most decimal fractions, so amounts
 * drifted the moment they were multiplied: 3 × 59.99 stored as
 * 179.97000000000003. A 2-decimal display formatter hid it, which is what made
 * it dangerous — the error only surfaced in aggregates and in tax returns
 * computed from the stored values.
 *
 * The USING clauses round on the way across, so existing rows land on the value
 * they were always displayed as. That is a lossy conversion by definition, and
 * it is deliberately done now rather than later: rounding demo data is trivial,
 * rounding a year of filed invoices is not.
 *
 * Scales: money to 2dp (paise). Quantity to 3dp, for units sold by weight or
 * volume. tax_rate is a percentage rather than an amount, so it gets its own
 * narrower type — GST rates run 0 to 28 and the smallest in use is 0.25.
 *
 * Idempotent: ALTER ... TYPE on a column that is already that type is a no-op
 * in Postgres, but the catalogue check keeps every later boot from rewriting
 * five tables for nothing.
 */
async function exactMoneyColumns() {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'items'
      AND column_name = 'unit_price'
      AND data_type = 'double precision'
  `);
  if (!rows.length) return;   // already migrated

  // One statement per table so a failure part-way is easy to read in the log.
  await pool.query(`
    ALTER TABLE items
      ALTER COLUMN unit_price          TYPE NUMERIC(14,2) USING ROUND(unit_price::numeric, 2),
      ALTER COLUMN quantity            TYPE NUMERIC(14,3) USING ROUND(quantity::numeric, 3),
      ALTER COLUMN low_stock_threshold TYPE NUMERIC(14,3) USING ROUND(low_stock_threshold::numeric, 3)
  `);
  await pool.query(`
    ALTER TABLE invoices
      ALTER COLUMN subtotal TYPE NUMERIC(14,2) USING ROUND(subtotal::numeric, 2),
      ALTER COLUMN total    TYPE NUMERIC(14,2) USING ROUND(total::numeric, 2),
      ALTER COLUMN tax_rate TYPE NUMERIC(6,3)  USING ROUND(tax_rate::numeric, 3)
  `);
  await pool.query(`
    ALTER TABLE invoice_line_items
      ALTER COLUMN quantity   TYPE NUMERIC(14,3) USING ROUND(quantity::numeric, 3),
      ALTER COLUMN unit_price TYPE NUMERIC(14,2) USING ROUND(unit_price::numeric, 2),
      ALTER COLUMN line_total TYPE NUMERIC(14,2) USING ROUND(line_total::numeric, 2)
  `);

  console.log('↪  Money and quantity columns converted to NUMERIC');
}

/**
 * Phase 2 — the records a tax invoice needs.
 *
 * Every field here is one a statutory GST document must carry: GST identity on
 * companies and items, and a supplier snapshot frozen onto each invoice at
 * issue. `ADD COLUMN IF NOT EXISTS` is idempotent on its own (Postgres 9.6+),
 * so most of this needs no catalogue check; the catalogue-check pattern above
 * is only needed where `IF NOT EXISTS` isn't available — replacing a UNIQUE
 * constraint and adding a CHECK.
 *
 * HSN/SAC, GST rate and UQC are left nullable rather than NOT NULL: enforcing
 * them is a Phase 4 concern, once real registration/scheme data exists to
 * decide which items need which.
 */
async function addGstFields() {
  await pool.query(`
    ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS gstin             TEXT,
      ADD COLUMN IF NOT EXISTS legal_name         TEXT,
      ADD COLUMN IF NOT EXISTS state_code         TEXT,
      ADD COLUMN IF NOT EXISTS pan                TEXT,
      ADD COLUMN IF NOT EXISTS scheme             TEXT NOT NULL DEFAULT 'regular',
      ADD COLUMN IF NOT EXISTS einvoice_enabled   BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS active             BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  `);

  await pool.query(`
    ALTER TABLE items
      ADD COLUMN IF NOT EXISTS hsn_sac_code TEXT,
      ADD COLUMN IF NOT EXISTS is_service   BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS gst_rate     NUMERIC(6,3) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS uqc          TEXT,
      ADD COLUMN IF NOT EXISTS cost_price   NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS active       BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  `);

  await pool.query(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS supplier_gstin      TEXT,
      ADD COLUMN IF NOT EXISTS supplier_name       TEXT,
      ADD COLUMN IF NOT EXISTS supplier_address    TEXT,
      ADD COLUMN IF NOT EXISTS supplier_state_code TEXT,
      ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  `);

  // A company's scheme is either regular or composition — only meaningful once
  // it has a GSTIN, but stored either way. Added separately from the column
  // above because a CHECK can't ride along on ADD COLUMN IF NOT EXISTS without
  // erroring on a re-run.
  await addConstraintIfMissing(
    'companies', 'companies_scheme_ck',
    `ALTER TABLE companies ADD CONSTRAINT companies_scheme_ck CHECK (scheme IN ('regular', 'composition'))`
  );

  // Partial unique indexes — CREATE INDEX already supports IF NOT EXISTS, so
  // these need no catalogue check of their own.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_gstin
      ON companies(gstin) WHERE gstin IS NOT NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_company_sku
      ON items(company_id, sku) WHERE sku IS NOT NULL
  `);


  // invoice_no moves from a single global UNIQUE to UNIQUE(company_id,
  // invoice_no): two companies running independent numbering series will
  // legitimately both reach the same number. ADD CONSTRAINT has no IF NOT
  // EXISTS, so this checks the catalogue on both ends of the swap.
  const { rows: oldConstraint } = await pool.query(`
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'invoices'
      AND constraint_name = 'invoices_invoice_no_key'
      AND constraint_type = 'UNIQUE'
  `);
  if (oldConstraint.length) {
    await pool.query(`ALTER TABLE invoices DROP CONSTRAINT invoices_invoice_no_key`);
  }
  await addConstraintIfMissing(
    'invoices', 'invoices_company_invoice_no_key',
    `ALTER TABLE invoices ADD CONSTRAINT invoices_company_invoice_no_key UNIQUE (company_id, invoice_no)`
  );

  // Only a registered supplier may charge GST at all (Section 122) — the
  // application layer rejects this earlier and with a better message, but the
  // database enforces it too, since a cross-table rule (does this invoice's
  // company have a GSTIN) can't itself be a constraint: the GSTIN is
  // snapshotted onto the invoice at issue specifically so this CHECK can see it.
  //
  // NOT VALID, deliberately: a real install can already hold invoices that
  // charged tax with no GSTIN, because GSTIN did not exist as a concept before
  // this phase — that was never invalid at the time. VALIDATE CONSTRAINT would
  // scan every existing row and refuse to add the constraint at all the moment
  // it found one. NOT VALID adds it un-scanned, so old rows are grandfathered
  // in while every new INSERT or UPDATE is checked from here on — the same
  // cutover-not-retrofit philosophy Phase 4 documents for numbering and tax.
  await addConstraintIfMissing(
    'invoices', 'invoices_supplier_gstin_ck',
    `ALTER TABLE invoices ADD CONSTRAINT invoices_supplier_gstin_ck
       CHECK (supplier_gstin IS NOT NULL OR tax_rate = 0) NOT VALID`
  );
}

/**
 * Phase 3 — stock you can audit.
 *
 * The tables themselves are created unconditionally above (CREATE TABLE IF
 * NOT EXISTS); this only adds what can't ride along on that — the reason
 * CHECK, and a one-time backfill so the ledger accounts for stock that
 * already existed before this phase.
 */
async function addStockLedger() {
  // A closed set of reasons, so a bad value is a constraint violation rather
  // than silent free text nobody can report on later.
  await addConstraintIfMissing(
    'stock_movements', 'stock_movements_reason_ck_v2',
    `ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reason_ck_v2
       CHECK (reason IN ('initial_stock', 'stock_in', 'stock_out', 'invoice_finalize', 'invoice_reversal', 'manual_adjustment'))`
  );

  await backfillOpeningBalances();
}

/**
 * Phase 5 — Stock In / Stock Out movements.
 *
 * Replaces the old invoice-centric reason set with a superset that includes
 * the new direct movement reasons. Idempotent: the new constraint name differs
 * from the old one, so this drops the old constraint (if still present) and
 * adds the new one in a single boot step.
 */
async function upgradeReasonConstraint() {
  // Already on the new constraint — nothing to do.
  const { rows: already } = await pool.query(`
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'stock_movements'
      AND constraint_name = 'stock_movements_reason_ck_v2'
  `);
  if (already.length) return;

  // Drop old constraint if present.
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = current_schema()
          AND table_name = 'stock_movements'
          AND constraint_name = 'stock_movements_reason_ck'
      ) THEN
        ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_reason_ck;
      END IF;
    END $$
  `);

  await pool.query(`
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reason_ck_v2
      CHECK (reason IN (
        'initial_stock', 'stock_in', 'stock_out',
        'invoice_finalize', 'invoice_reversal', 'manual_adjustment'
      ))
  `);
  console.log('\u21aa  Upgraded stock_movements reason constraint (added stock_in / stock_out)');
}

/**
 * Phase 6 — admin / sub-admin roles.
 *
 * Every existing account defaults to 'admin', so this ships with no behavior
 * change for anyone already using the app: admin access is exactly the
 * unscoped access every account already had. 'sub_admin' only starts meaning
 * anything once rows exist in user_companies (see middleware/auth.js and
 * middleware/rbac.js).
 */
async function addRoleAndCompanyScoping() {
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'
  `);
  await addConstraintIfMissing(
    'users', 'users_role_ck',
    `ALTER TABLE users ADD CONSTRAINT users_role_ck CHECK (role IN ('admin', 'sub_admin'))`
  );
}

/**
 * Phase 7 — company feature toggles.
 *
 * feature_key is a closed set, same reasoning as stock_movements.reason: a
 * typo should fail at write time, not sit silently unmatched forever. The
 * constraint name is versioned (_v1) on purpose — adding a new feature key
 * later means adding a `_v2` constraint that supersedes this one, the same
 * way upgradeReasonConstraint() replaced the original reason CHECK, because
 * ADD CONSTRAINT has no "OR REPLACE" and a constraint name only gets checked
 * for existence, never for whether its definition is still current.
 */
async function addFeatureFlags() {
  const keyList = FEATURE_KEYS.map((k) => `'${k}'`).join(', ');
  await addConstraintIfMissing(
    'company_features', 'company_features_key_ck_v1',
    `ALTER TABLE company_features ADD CONSTRAINT company_features_key_ck_v1
       CHECK (feature_key IN (${keyList}))`
  );
}

/**
 * Phase 8 — the fields a GST tax invoice is legally required to carry
 * (CGST Rules, Rule 46) that the Phase 4a/4b tax engine didn't need on its
 * own: the recipient's own details (name/email already existed, but not
 * address/GSTIN/state — i.e. place of supply), a delivery address when it
 * differs from the recipient's, whether the supply is billed under reverse
 * charge, and a printed signatory line since no Digital Signature Certificate
 * integration exists here.
 *
 * hsn_sac_code/uqc move onto the line item (not just items.hsn_sac_code) for
 * the same reason gst_rate was already snapshotted there in Phase 4b: an
 * item's HSN code changing later must not retroactively alter an invoice
 * already issued under the old one.
 */
async function addInvoiceLegalFields() {
  await pool.query(`
    ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS authorized_signatory_name TEXT
  `);
  await pool.query(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS customer_address        TEXT,
      ADD COLUMN IF NOT EXISTS customer_gstin           TEXT,
      ADD COLUMN IF NOT EXISTS customer_state_code      TEXT,
      ADD COLUMN IF NOT EXISTS delivery_address         TEXT,
      ADD COLUMN IF NOT EXISTS reverse_charge           BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS supplier_signatory_name  TEXT
  `);
  await pool.query(`
    ALTER TABLE invoice_line_items
      ADD COLUMN IF NOT EXISTS hsn_sac_code TEXT,
      ADD COLUMN IF NOT EXISTS uqc          TEXT
  `);
}

/**
 * Phase 9 — indexes matching query patterns that emerged only after the
 * features they serve shipped (invoice listing, item deletion's reference
 * check). `idx_invoices_company` alone covers the WHERE but not the ORDER BY
 * on the invoice list/pagination query, so every page fetch paid for a
 * separate sort step; the composite index lets Postgres satisfy the WHERE
 * and the ORDER BY from the same index scan.
 */
async function addPerformanceIndexes() {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invoices_company_created
      ON invoices(company_id, created_at DESC, id DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_line_items_item
      ON invoice_line_items(item_id)
  `);
}

/**
 * Give every item's pre-existing stock a starting movement.
 *
 * Without this, an item that already had 50 units on hand before this phase
 * shipped would show 50 on the shelf but nothing in its history — the ledger
 * would be authoritative for every unit received afterward and silent about
 * every one received before. One `initial_stock` row per item with
 * `quantity > 0` and no movement history yet, dated at the item's own
 * `created_at`, closes that gap: the sum of an item's movements matches
 * `items.quantity` exactly from here on.
 *
 * Gated per item via `NOT EXISTS`, not a table-wide "is this the first boot"
 * check: an item created after this migration already gets its own
 * `initial_stock` row at creation time (see routes/items.js), and this must
 * not re-backfill on top of that just because it runs on the same boot as
 * some unrelated item's very first movement. Safe to run on every boot —
 * once an item has any movement row, it is permanently excluded.
 */
async function backfillOpeningBalances() {
  const { rowCount } = await pool.query(`
    INSERT INTO stock_movements (item_id, company_id, quantity_delta, reason, created_at)
    SELECT i.id, i.company_id, i.quantity, 'initial_stock', i.created_at
    FROM items i
    WHERE i.quantity > 0
      AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.item_id = i.id)
  `);
  if (rowCount > 0) {
    console.log(`↪  Backfilled opening-balance movements for ${rowCount} item${rowCount === 1 ? '' : 's'}`);
  }
}

/**
 * Phase 4a+4b — per-company numbering and the tax engine.
 *
 * The `invoice_number_series` table is created unconditionally above; this
 * only adds the new invoice/line-item columns and the two CHECKs that keep a
 * company without a GSTIN, or on the composition scheme, from ever ending up
 * with tax on an invoice — regardless of what its items say.
 *
 * `tax_rate` is untouched: it keeps its historical meaning and values for
 * invoices issued before this phase, and the new engine never writes it.
 */
async function addTaxEngine() {
  await pool.query(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS place_of_supply_state TEXT,
      ADD COLUMN IF NOT EXISTS supplier_scheme       TEXT,
      ADD COLUMN IF NOT EXISTS cgst_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sgst_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS igst_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS round_off  NUMERIC(14,2) NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE invoice_line_items
      ADD COLUMN IF NOT EXISTS gst_rate    NUMERIC(6,3)  NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS igst_amount NUMERIC(14,2) NOT NULL DEFAULT 0
  `);

  // Unlike Phase 2's GSTIN check, both of these can be validated immediately
  // rather than added NOT VALID: every row's cgst/sgst/igst columns default
  // to 0 (including every pre-existing row, via the ADD COLUMN above), so no
  // row in a real database can already be violating either one.
  await addConstraintIfMissing(
    'invoices', 'invoices_tax_requires_gstin_ck',
    `ALTER TABLE invoices ADD CONSTRAINT invoices_tax_requires_gstin_ck
       CHECK (supplier_gstin IS NOT NULL OR (cgst_total = 0 AND sgst_total = 0 AND igst_total = 0))`
  );
  // A composition-scheme company has a GSTIN, so the check above alone
  // wouldn't stop it being charged tax — a cross-table rule ("this company's
  // scheme") can't be a constraint unless it's copied onto the row the
  // constraint lives on, same reasoning as the supplier GSTIN snapshot.
  await addConstraintIfMissing(
    'invoices', 'invoices_tax_requires_regular_scheme_ck',
    `ALTER TABLE invoices ADD CONSTRAINT invoices_tax_requires_regular_scheme_ck
       CHECK (supplier_scheme = 'regular' OR (cgst_total = 0 AND sgst_total = 0 AND igst_total = 0))`
  );
}

/**
 * Phase 10 — companies.item_count / low_stock_count / stock_value, maintained
 * columns replacing the LEFT JOIN + GROUP BY over `items` that
 * getCompaniesWithStats() used to run on every cache miss (see
 * routes/companies.js and lib/companyAggregates.js, which every item/quantity
 * mutation now calls to keep these in sync).
 *
 * The backfill below runs on every boot, not just the first time these
 * columns are added — it's bounded by total item count, runs once at
 * startup rather than on any request path, and doubles as a self-healing
 * pass against drift, which is exactly the failure mode a recompute-based
 * design (as opposed to incrementing counters at each call site) exists to
 * avoid in the first place.
 */
async function addCompanyAggregateColumns() {
  await pool.query(`
    ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS item_count     INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS low_stock_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS stock_value     NUMERIC(14,2) NOT NULL DEFAULT 0
  `);

  await pool.query(`
    UPDATE companies c
    SET item_count = agg.item_count,
        low_stock_count = agg.low_stock_count,
        stock_value = agg.stock_value
    FROM (
      SELECT
        i.company_id,
        COUNT(*)::int AS item_count,
        COALESCE(SUM(CASE WHEN i.quantity <= i.low_stock_threshold THEN 1 ELSE 0 END), 0)::int AS low_stock_count,
        COALESCE(SUM(i.quantity * i.unit_price), 0) AS stock_value
      FROM items i
      GROUP BY i.company_id
    ) agg
    WHERE c.id = agg.company_id
  `);

  // A company with zero items has nothing for the GROUP BY above to
  // produce, so it needs its own pass back to zero — otherwise one whose
  // last item was deleted between boots would keep whatever stale numbers
  // it last had instead of reflecting its now-empty catalog.
  await pool.query(`
    UPDATE companies
    SET item_count = 0, low_stock_count = 0, stock_value = 0
    WHERE id NOT IN (SELECT DISTINCT company_id FROM items)
  `);
}

/**
 * Phase 11 — idempotent invoice-draft creation (scalability audit finding
 * #7). A client-side network retry — the request timed out locally after the
 * server already committed, more likely as concurrent load and network
 * variance grow, not less — otherwise creates a second, indistinguishable
 * draft invoice with no way for the server to recognize it as the same
 * logical request. `POST /:id/finalize` already has this for free (the row
 * is locked FOR UPDATE and a second call sees a non-draft status); draft
 * creation had no equivalent.
 *
 * The column is nullable and the index partial (WHERE idempotency_key IS
 * NOT NULL) — a caller that never sends the header keeps behaving exactly
 * as before, unaffected by this migration or the route's new-but-optional
 * check, same pattern as idx_companies_gstin above.
 */
async function addInvoiceIdempotencyKey() {
  await pool.query(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS idempotency_key TEXT
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_company_idempotency_key
      ON invoices(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  `);
}

/**
 * A structured reference for a stock movement — a supplier's bill number, a
 * workshop job number, a customer's own delivery challan — as distinct from
 * `note`, which is free-text description. Stock in/out/correction all funnel
 * through one endpoint now (routes/stock.js POST /movements); this is what
 * makes "find everything against bill #1234" a real lookup instead of a text
 * search over notes.
 */
async function addStockMovementReference() {
  await pool.query(`
    ALTER TABLE stock_movements
      ADD COLUMN IF NOT EXISTS reference_no TEXT
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_stock_movements_reference
      ON stock_movements(company_id, reference_no) WHERE reference_no IS NOT NULL
  `);
}

/** Add a named constraint only if a constraint with that name doesn't already exist. */
async function addConstraintIfMissing(table, constraintName, addSql) {
  const { rows } = await pool.query(`
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = $1
      AND constraint_name = $2
  `, [table, constraintName]);
  if (rows.length) return;   // already applied
  await pool.query(addSql);
}

/** Close the pool — used by scripts so the process can exit cleanly. */
function closeDB() {
  return pool.end();
}

// Postgres SQLSTATE codes worth mapping to specific HTTP responses.
const PG_UNIQUE_VIOLATION      = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

module.exports = {
  pool,
  query,
  runTransaction,
  initDB,
  closeDB,
  // Exported so the test suite can drive the migration against a schema it
  // has deliberately put into the pre-migration shape, rather than asserting
  // against a reimplementation of it.
  applySchemaUpdates,
  addGstFields,
  addStockLedger,
  addTaxEngine,
  addRoleAndCompanyScoping,
  addFeatureFlags,
  addInvoiceLegalFields,
  addPerformanceIndexes,
  addCompanyAggregateColumns,
  addInvoiceIdempotencyKey,
  PG_UNIQUE_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
};
