# StockFlow — Implementation Roadmap

Taking StockFlow from working software to a statutory Indian GST invoicing
system. Ten improvements, sequenced into six phases by what actually blocks
what.

**Status:** Phases 0–3 complete · Phase 4 in progress (4a+4b done; 4c–4e next)

| | Phase | Size | Status |
| --- | --- | --- | --- |
| 0 | Guard rails | S | ✅ **Complete** |
| 1 | Exact money | S | ✅ **Complete** |
| 2 | The records a tax invoice needs | M | ✅ **Complete** |
| 3 | Stock you can audit | L | ✅ **Complete** |
| 4 | GST compliance — documents, not returns | L | 🟡 In progress — 4a+4b done, 4c–4e next |
| 5 | Scale and operations | M | ⬜ Not started |

Deferred by request: **CI**. The Phase 0 test suite is what makes it worth
having — once those tests exist, wiring them to run on push is a short config
file rather than a project.

---

## Why GST reorders the list

Three items change character once invoices become statutory documents rather
than internal records.

- **Money as floating point** goes from a latent rounding annoyance to a
  compliance risk. GST tax is computed per line to the paisa and rounded by
  rule; a return that disagrees with the invoice by a rupee is a real problem.
- **Customers as free text** becomes impossible. A tax invoice must carry the
  recipient's GSTIN and place of supply, and neither can hang off a retyped name.
- **Credit notes** stop being a generic "undo" and become a Section 34 document
  with their own numbering series. So they are built once, inside the GST phase,
  on top of the stock ledger — rather than built generically first and rebuilt
  to statutory shape later.

## Where each item lands

| # | Item | Phase | Status |
| --- | --- | --- | --- |
| 1 | Money → `NUMERIC` | 1 | ✅ |
| 2 | Test suite | 0 | ✅ |
| 3 | Correcting a finalized invoice | 3 + 4 | 🟡 Partial — reversal mechanism done, Phase 4's credit-note wrapper pending |
| 4 | Stock movement ledger | 3 | ✅ |
| 5 | Inbound / goods received | 3 | ✅ |
| 6 | Customers as entities | 2 | ✅ |
| 7 | GST compliance | 2 + 4 | 🟡 Partial — Phase 2's document fields, numbering (4a) and the tax engine (4b) done; documents (4c/4d) and export (4e) pending |
| 8 | Security hardening | 0 + 5 | 🟡 Partial — throttles and headers done, audit log pending |
| 9 | Server-side pagination | 5 | ⬜ |
| 10 | Smaller items | 2 + 5 | 🟡 Partial — error boundary and archive/active flags done |

---

## ✅ Phase 0 — Guard rails

*Before anything else moves.* **Complete.**

Everything after this phase changes money, schema, or tax maths. Tests written
against current behaviour are what make those changes provable rather than
hopeful.

- [x] **Test harness and integration suite** — 45 tests, all passing.
      `cd backend && npm test`
  - [x] Auth: session lifecycle, HttpOnly cookie, deleted-account revocation,
        password change, unauthenticated rejection
  - [x] Invoices: create → finalize → stock deduction, insufficient-stock
        refusal, partial-fill rollback, draft edit, finalized immutability,
        dashboard stats, invoice-number uniqueness
  - [x] Users: no roles, self-delete guard, last-account guard, hash never
        returned
  - [x] Migration: the tenancy drop driven against a schema deliberately put
        back into pre-migration shape, plus idempotency
  - [x] Rate limiting (opts back in; disabled for the other suites)
- [x] **Login rate limiting** — 10 failed attempts per IP per 15 minutes.
      Successful sign-ins are not counted, so a shared office is not punished.
      Password changes have their own limiter; `/api` has a generous backstop.
- [x] **`trust proxy` set to one hop** — without it every visitor counts as one
      client behind a proxy; trusting `true` would let a client forge
      `X-Forwarded-For` and skip the limiter entirely.
- [x] **helmet** with a hand-written CSP — the default policy would have blocked
      Google Fonts and left the UI in a fallback face.
- [x] **React error boundary** — a render fault now shows a recovery screen
      instead of a blank page.
- [x] **Fixed:** the migration's `information_schema` lookup was not scoped to a
      schema, so it matched a `users` table in *any* schema. Harmless today,
      wrong the moment a second schema exists — which is what the tests create.

### What the tests are worth

The first concurrency test was worthless, and that only surfaced by trying to
break it. Deleting the `FOR UPDATE` from the finalize transaction — the row lock
that stops two requests both deducting stock — did not fail the test. It passed
three runs out of three. Firing two requests with `Promise.all` does not
reproduce a race over a network: the second request's status check lands after
the first has committed, so it takes the ordinary "already finalized" path and
the test looks green whether the lock is there or not.

The rewrite holds a row lock from the test itself to park the first request
mid-transaction, and polls `pg_stat_activity` to confirm both requests are
genuinely blocked before releasing — no sleep-and-hope. The same mutation now
fails with `[200, 200]`: both requests finalizing, stock deducted twice.

**Standard for the rest of the suite:** a test only counts once you have watched
it fail for the right reason.

### Notes

- The suite is latency-bound, not CPU-bound. Against a hosted database every
  request is a round trip and the run takes a couple of minutes. Point
  `TEST_DATABASE_URL` at a local Postgres for a fast edit-test loop.
- Isolation uses a `stockflow_test` schema, created and dropped around each run.
  `public` is never read or written. Neon's pooled endpoint rejects the
  connection parameter this needs, so the harness rewrites to the direct
  endpoint automatically.
- Rate limit counting is in-process. On one long-running server that is correct;
  on serverless each instance keeps its own tally, so move the store to Postgres
  or Redis if the deployment fans out widely.

---

## ✅ Phase 1 — Exact money

*Decimals that survive arithmetic.* **Size: S — Complete.**

GST tax is specified to the paisa, so the tax engine in Phase 4 has to stand on
exact decimals — building it on floats guarantees off-by-a-paisa disputes with
an accountant.

- [x] `unit_price`, `subtotal`, `total`, `line_total` → `NUMERIC(14,2)`
- [x] `quantity`, `low_stock_threshold` → `NUMERIC(14,3)` — the atomic deduction
      compares quantities, and float drift on fractional kg could fail a valid
      deduction or pass an invalid one
- [x] `tax_rate` → `NUMERIC(6,3)`, narrower than planned: it is a percentage,
      not an amount. GST rates run 0–28 and the smallest in use is 0.25
- [x] `CREATE TABLE` updated too, so a fresh install is created correct rather
      than created wrong and immediately migrated
- [x] **`lib/money.js`** — exact arithmetic on `decimal.js`, and the rounding
      policy in one documented place
- [x] Invoice totals, line totals and item writes all routed through it
- [x] Frontend comparison sites hardened against string amounts
- [x] 17 new tests (62 total, all passing)

### The rounding policy

1. Money carries 2 decimal places; quantities carry 3.
2. Rounding is **half-up** — `0.125` → `0.13`. The ordinary Indian commercial
   convention, and what an accountant checking by hand will do. Not banker's
   rounding.
3. A line total is rounded once, and the subtotal is the **sum of the rounded
   line totals** — not a rounded sum of unrounded ones. Those differ, and an
   invoice whose lines do not add up to the total printed beneath them is
   indefensible.

GST's own rule — invoice total rounded to the nearest rupee with the difference
on an explicit round-off line — belongs with the tax engine in Phase 4. This
phase gives it exact inputs.

### The decision worth knowing about

`pg` returns `NUMERIC` as **strings** by default, precisely to avoid the
precision loss this phase set out to fix. Overriding that needs an argument, so:
the driver is configured to return numbers, and exactness lives in `lib/money.js`
instead, which computes in `Decimal` and hands back strings for storage.

The reason is a bug the string form would have caused. `NUMERIC(14,3)` arrives
as `"10.000"`, and `"10.000" <= "5.000"` is **true** — two strings compare
lexicographically. That is the low-stock test in `Stock.jsx`, so every
well-stocked item would have been flagged Low. The values are bounded well
inside a double's exact-integer range (`NUMERIC(14,2)` scaled to paise is 10^14
against a limit of 9×10^15), so nothing is lost on the wire. A test pins the
contract, and the frontend comparison sites now coerce explicitly rather than
trusting it.

**Verified:** `3 × 59.99` now stores and returns `179.97`, not
`179.97000000000003`. At 18% tax the invoice totals `212.36`. Existing seeded
rows converted with values intact; the conversion is idempotent and re-running it
is a no-op.

### Known boundary

The frontend still computes its *preview* subtotal in the invoice modal, and the
stock-value column, with JavaScript arithmetic. Both are display-only and
rounded to 2dp for output; the server recomputes authoritatively on save. Worth
revisiting if a preview ever disagrees with a saved total by a paisa.

---

## ✅ Phase 2 — The records a tax invoice needs

*Schema before logic.* **Size: M — Complete.**

Every field below is one a tax invoice legally must carry. Added as plain
data — additive, low risk, no behaviour change to existing flows — so Phase 4
is about tax logic instead of schema churn in the middle of the hardest work.

- [x] **Customers** as first-class records — name, address, GSTIN, and state,
      scoped per company (`customers.company_id`, mirroring `items`) rather than
      shared across companies. New `routes/customers.js` + `Customers.jsx` page
- [x] **Companies** gain GSTIN, legal name, state code, PAN, a **scheme flag**
      (regular or composition) and `einvoice_enabled`. GSTIN is **optional but
      unique when present** (partial unique index), and it is the switch the
      rest of the tax behaviour hangs off — see Phase 4. State code drives the
      CGST/SGST-versus-IGST split for the companies that have one
- [x] **Items** gain HSN/SAC code, a **goods-or-service** flag (`is_service`), a
      GST rate, and a UQC (the standard unit code returns are filed in) — all
      left nullable/optional rather than required, since enforcing them is a
      Phase 4 concern once Q1/Q3/Q4 (registration, scheme, goods-vs-services)
      are settled per record
- [x] Cost price alongside sale price, so margin and stock valuation stop being
      guesses
- [x] `UNIQUE(company_id, sku)` for non-null SKUs (partial unique index)
- [x] `invoices.invoice_no` from `UNIQUE` to **`UNIQUE(company_id, invoice_no)`**.
      Two companies running independent series can now legitimately reach the
      same number; it only widens what is accepted, so nothing existing broke
- [x] **Supplier snapshot on the invoice** — `supplier_gstin`, name, address and
      state copied onto each invoice at issue (from the company row), plus a
      `CHECK (supplier_gstin IS NOT NULL OR tax_rate = 0)`, enforced at the
      application layer too with a clearer error. A cross-table rule cannot be
      a database constraint on its own; snapshotting the GSTIN makes it one
- [x] Archive / active flags for items and companies (and customers), with an
      archive/reactivate action in each list UI alongside the existing hard delete
- [x] `updated_at` throughout (companies, items, invoices, customers)
- [x] Frontend: GST fields wired into the Companies and Stock forms, a new
      Customers page, and Invoices' free-text customer replaced by a
      customer picker (with an inline "add customer" shortcut) that still
      accepts a manual override name

**Done when:** an invoice can be raised against a saved customer, every item
carries HSN or SAC + GST rate + UQC, duplicate SKUs inside a company are rejected
while identical invoice numbers across companies are not, and the database itself
refuses an invoice that charges tax without a supplier GSTIN behind it. ✅

**Unaffected by returns being filed elsewhere.** Every field here describes the
document rather than the return — see Phase 4.

### The migration wrinkle worth knowing about

The supplier-GSTIN `CHECK` cannot be validated against existing data: a real
install can already hold invoices that charged tax with no GSTIN, because GSTIN
did not exist as a concept before this phase — that was never invalid at the
time it happened. `VALIDATE CONSTRAINT`-style addition would scan every row and
refuse to add the constraint the moment it found one (and it did, against this
project's own database). The fix is `ADD CONSTRAINT ... CHECK (...) NOT VALID`:
the constraint applies to every new `INSERT`/`UPDATE` from here on, but existing
rows are grandfathered in un-scanned — the same cutover-not-retrofit approach
Phase 4 documents for numbering and tax.

---

## ✅ Phase 3 — Stock you can audit

*Every movement attributable.* **Size: L — Complete.**

Needs the exact quantities from Phase 1. Also produces the reversal mechanism
that Phase 4's credit note sits on top of, so the reversal is written once and
wrapped later rather than built twice.

- [x] An append-only **movement ledger** (`stock_movements`): quantity delta,
      reason, document reference (invoice or goods receipt), user, timestamp.
      `items.quantity` is now a maintained **cache** of the ledger's sum,
      written only alongside a ledger row — never a bare overwrite. A closed
      `reason` set (`initial_stock`, `invoice_finalize`, `invoice_reversal`,
      `goods_received`, `manual_adjustment`) is enforced by a database CHECK.
      Every install's pre-existing stock was backfilled with one
      `initial_stock` row per item, dated at the item's own `created_at`, so
      the ledger accounts for it from before this phase shipped
- [x] Finalize writes ledger entries instead of mutating quantity in place —
      via a shared `lib/stockLedger.js#applyMovement`, a generalisation of the
      original atomic guard (`quantity >= amount` → `quantity + delta >= 0`)
      that every stock-moving route now goes through
- [x] **Reversal** — `POST /api/invoices/:id/reverse` undoes a finalized
      invoice, restoring stock through the ledger and moving it to a new
      `reversed` status exactly as immutable as `finalized` (no further edit,
      delete, or re-finalize). The statutory document wrapping it — a credit
      note — comes in Phase 4
- [x] **Inbound / goods received** (`goods_receipts` + line items): a
      multi-line document — company, supplier, date, notes — carrying cost per
      line, mirroring how invoices are structured. Immutable once created, the
      same "it's part of the record" reasoning as a finalized invoice; a
      mistaken receipt is corrected with a manual adjustment and a note
- [x] **Manual stock adjustment** (`POST /api/items/:id/adjust`) — the
      replacement for the old free-text quantity field on the item edit form,
      which was a silent, unlogged hole in the audit trail. Takes the new
      total (not a delta, since that is how a physical count is actually
      phrased) plus a required reason
- [x] Frontend: an "Adjust Stock" action and a per-item movement history view
      on the Stock page, a new Goods Receipts page, and a "Reverse" action on
      finalized invoices

**Done when:** every quantity change traces to a dated, attributed movement;
stock is reconstructable as of any past date; and a finalized invoice can be
reversed with stock restored. ✅

### The concurrency guarantee this phase had to preserve

Finalize's stock deduction was already covered by a deliberately adversarial
test (Phase 0): two requests racing on the same item must deduct stock exactly
once, proven by forcing the interleaving rather than hoping for it. Routing
finalize through the new shared `applyMovement` helper could easily have
reintroduced that race if the deduction had stopped being a single `UPDATE ...
WHERE ...` statement. It didn't — the guard clause changed shape
(`quantity >= amount` to `quantity + delta >= 0`, to cover stock leaving and
arriving with the same statement) but the row-level lock it takes is
unchanged, so the existing race test needed no rewrite. A new adversarial test
extends the same technique to a manual adjustment racing a finalize on the
same item, and asserts the cached quantity and the ledger's own sum agree no
matter which one the database happened to run first.

---

## 🟡 Phase 4 — GST compliance

*The phase the rest exists to support.* **Size: L — 4a+4b complete, 4c–4e next.**

Returns are filed outside this system, so the reporting layer is out of scope.
The document layer is not. An invoice is a legal document the moment it leaves
here, and it has to be correct on its own terms regardless of who files the
return afterwards — which is why everything below except 4e survives that
decision unchanged.

Where a company is registered, it issues under its **own** GSTIN, so everything
below is **per company**:
its own numbering series, its own supplier state, its own scheme, its own
threshold, its own export.

And a company may have no GSTIN at all. Only a registered person may collect
GST — charging it without registration is not a formatting mistake, it is an
offence under Section 122. So **GSTIN presence is the switch**, and it decides
which of three documents a company issues:

| Company | Document | Tax |
| --- | --- | --- |
| GSTIN, regular scheme | Tax invoice | CGST + SGST or IGST, per line |
| GSTIN, composition scheme | Bill of supply | None; prescribed declaration instead |
| No GSTIN | Plain invoice | **None, and the tax controls are not offered** |

The third row is not a degraded case to warn about — it is a company invoicing
correctly. The UI should not show a tax-rate field it will refuse to honour, and
the API should reject a non-zero rate rather than silently zero it, so a
misconfigured integration is loud instead of quietly wrong.

- [x] **4a · Numbering series, one per company** — each company issues under its
      own GSTIN, so each keeps its own counter: sequential per financial year
      (1 April – 31 March), within 16 characters, alphanumeric plus `/` and
      `-`, and a separate series per document type. A property of the invoice,
      not of the return, so filing elsewhere does not remove it.
      *Mechanics:* a counter row per (company, document type, financial year)
      in the new `invoice_number_series` table, allocated inside finalize's
      existing transaction via a single atomic `INSERT ... ON CONFLICT DO
      UPDATE` — simpler than the originally planned `SELECT … FOR UPDATE` and
      equally race-safe, since Postgres serializes concurrent upserts on the
      same key through the same row-level locking either approach needs.
      Sequential means the number is taken at issue (finalize), not at draft —
      a draft keeps the old random `INV-YYYYMMDD-XXXX` placeholder shape, so an
      abandoned draft never burns a real number.
      *Cutover:* existing `INV-YYYYMMDD-<random>` numbers are not sequential and
      were not retro-fitted. Old invoices keep their numbers; each company
      starts a new series from its next finalize.
- [x] **4b · Tax engine** — runs only for a company with a GSTIN, and only on the
      regular scheme (`lib/gst.js` + `routes/invoices.js`'s `taxContext`).
      Place of supply is the billed customer's state, which is why a
      tax-charging company can no longer invoice a manual-entry name — it must
      bill a saved `customers` row that has a state on file. Same state as the
      supplier splits into CGST + SGST, computed **independently at half the
      item's own rate each** (not the full tax divided by two, which can be a
      paisa off); a different state charges IGST in full. Tax runs per line at
      that line's own item's `gst_rate` — the old single, manual, invoice-wide
      "Tax Rate (%)" field is gone entirely, both from the API and the UI.
      The invoice total rounds to the nearest rupee **only when there is
      actual tax to round around** — an untaxed invoice, or one whose items
      are all nil-rated, stays exact to the paisa like everything else in this
      app — with the difference shown on an explicit round-off line.
      Supplier GSTIN, legal name, address, state **and scheme** are
      snapshotted onto the invoice at issue (two new database CHECKs enforce
      both: no tax without a GSTIN, and no tax outside the regular scheme,
      each validated immediately since every row's tax columns default to
      zero) — a company that later registers, changes scheme, or moves state
      must not retroactively change a document already sent.
      *Cutover:* a company acquiring a GSTIN starts charging tax from that point
      forward. Invoices already issued stay untaxed, and are correct that way.
      *Deferred to 4d:* the PDF only got the minimal fix needed to display the
      new CGST/SGST/IGST/round-off breakdown correctly (falling back to the
      old flat-rate display for pre-Phase-4 invoices) — the three-variant
      compliant redesign (HSN/UQC table, totals in words, signature block) is
      still 4d's job.
- [ ] **4c · Credit and debit notes** — Section 34 documents with their own
      series, linked to the original invoice, reversing stock through the Phase 3
      ledger. Completes item 3.
- [ ] **4d · Compliant document PDF** — a rewrite, not an edit, and now three
      variants selected by GSTIN presence and scheme: a **tax invoice**, a
      **bill of supply**, and a **plain invoice** for an unregistered company,
      which carries no GSTIN block, no tax columns and no GST declaration.
      The registered variants print supplier GSTIN, name and registered address;
      document number and date; recipient details and GSTIN; place of supply; per
      line the HSN or SAC, quantity, UQC and taxable value — plus, on the tax
      invoice, rate and tax amount per head; total in words; reverse-charge flag;
      signature block.
- [ ] **4e · Accountant handover export** — invoices with their tax breakup as
      CSV, scoped to **one company and one period**, since each files separately
      and may not share an accountant. Only meaningful for a company with a
      GSTIN; an unregistered one has no return to hand over. A convenience for
      whoever files, not a compliance feature: without it every invoice is
      re-keyed by hand into another system, which is slow and is exactly where
      transcription errors enter a tax return. Deliberately not the GSTR-1 schema.

### What filing elsewhere removes — and what it does not

**Removed.** GSTR-1 as return-ready JSON, and the filing machinery that came
with it: QRMP frequency, CMP-08 and GSTR-4, B2C-small aggregation buckets, the
HSN summary table. All of that is reporting, and reporting now happens somewhere
else.

**Not removed — e-invoicing.** It is not a filing requirement. It happens at the
moment an invoice is created, not at month end. Above the turnover threshold, an
invoice must carry an IRN and a signed QR code *before it reaches the customer*,
or it is not a valid tax invoice at all — no matter who files the return. Since
this system produces the document, that obligation lands here.

So `companies.einvoice_enabled` stays in Phase 2, and the IRP integration stays
**deferred but planned** rather than deleted. E-way bills are deferred on the
same terms. Both are additive once the tax engine and numbering exist.

Everything else about the document survives for the same reason: numbering,
the composition-scheme flag that picks the variant, customer GSTIN and state,
HSN/SAC, per-line tax, and the round-off line.

**Done when:** an invoice or bill of supply can be handed to a customer's
accountant without amendment, and the CSV export carries every figure printed on
it.

---

## ⬜ Phase 5 — Scale and operations

*Once the shape has settled.* **Size: M**

None of this blocks correctness or compliance, and all of it is easier once the
data model has stopped moving — pagination written against the pre-GST invoice
shape would be rewritten twice.

- [ ] Server-side pagination, filtering and sorting. Today's controls are
      client-side over fully loaded lists — fine at three companies, not at three
      thousand invoices
- [ ] A dedicated dashboard endpoint. It currently fetches every invoice to
      display eight
- [ ] Audit log: who finalized, voided, or deleted what. Sharper once documents
      are statutory
- [ ] Structured logging and error monitoring — production failures are
      invisible right now
- [ ] CSV import, and exports beyond the Phase 4e accountant handover
- [ ] Route-level code splitting for the ~390 KB single bundle

**Done when:** list endpoints page and filter server-side, and a production error
reaches you without a customer reporting it.

---

## Decisions still needed

**Settled.** **Q2 — each company issues under its own GSTIN, where it has one.**
Every company is its own supplier, so numbering series, the tax engine’s supplier
side, the e-invoicing threshold and the handover export are all per company rather
than global. A company without a GSTIN charges no tax at all — GSTIN presence is
the switch. Both consequences are folded into Phases 2 and 4 above.

The rest shape Phase 2 and Phase 4 rather than merely informing them, so they are
worth settling before that work starts.

| | Question | Why it matters |
| --- | --- | --- |
| **Q1** | Which companies are registered, and what is each one’s turnover band? | Registration decides whether a company charges tax at all. Above the threshold it also decides e-invoicing and e-way bill applicability — both document-time obligations — and how many HSN digits each line must carry. One company crossing it pulls the IRP integration forward for the whole system. |
| **Q3** | For the registered ones: regular scheme or composition? | Picks between 4d’s first two variants. A composition dealer issues a bill of supply and cannot charge GST on it. Unregistered companies bypass this question entirely and get the third variant. |
| **Q4** | Goods only, or any services? | HSN for goods, SAC for services. Applies to every company — an unregistered one still describes what it sold, it just does not tax it. Cheap to support both now, awkward to retrofit. |
| **Q5** | Rounding policy, stated explicitly? | Proposed default: tax computed per line, invoice total rounded to the nearest rupee with a visible round-off line. Worth confirming against how your accountant already works. |
| **Q6** | Export shape — and how many accountants? | 4e is a handover file, so its columns should match what the filing software imports. With per-company GSTINs each registered company may use a different accountant, so the export is scoped to one company and one period. Cheap to shape now, annoying to renegotiate after the first month-end. |

Phases 0 and 1 were blocked on none of these, and are done.

---

## Two standing caveats

**Rates and thresholds move.** GST slabs and the e-invoicing threshold have both
been revised more than once, most recently in the 2025 rate restructuring.
Nothing in this plan hardcodes a rate or a threshold — they belong in
configuration, verified against current CBIC notifications before go-live and
reviewed after each change. Treat any specific figure here as needing
confirmation rather than as authority.

**This is engineering sequencing, not tax advice.** The structural requirements
above are stable and well documented, but the invoice format — and the handover
export it feeds — should get a look from whoever signs off your filings before
the first real invoice goes out.

---

## Previously completed

Work finished before this roadmap was drawn up, for context on why some of the
groundwork is already in place.

- **UX review and fixes** — a full pass over the frontend, then all findings
  fixed across four rounds: mobile navigation (the sidebar was unreachable below
  640px), the finalize dead end, sticky error toasts, session-expiry recovery,
  truthful empty states, unsaved-changes guards, focus trapping and
  Enter-to-submit in modals, URL-backed navigation state, in-flight feedback on
  destructive actions, table sorting and pagination, and a long tail of smaller
  items.
- **Company-admin role removed end to end** — companies became records whose
  stock is managed rather than tenants who log in. `users.role` and
  `users.company_id` dropped along with both CHECK constraints, all per-company
  query scoping removed, and the frontend's role branching deleted.
