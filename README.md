# StockFlow — Inventory & Invoicing

Company-wise inventory management with stock tracking and PDF invoice generation.

- **Backend** — Express 4 REST API, Postgres, JWT auth in an httpOnly cookie
- **Frontend** — React 18 + React Router 6, built with Vite
- **Invoices** — created as drafts, then *finalized*, which atomically deducts stock

---

## Requirements

- **Node.js 18+** (developed on 24.6)
- A **Postgres** database — [Neon](https://neon.tech) works well and has a free tier

---

## Setup

### 1. Install dependencies

Installs the root, backend, and frontend packages in one step:

```bash
npm run install:all
```

### 2. Configure the environment

```bash
cp backend/.env.example backend/.env
```

Then edit `backend/.env` and set:

| Variable       | Purpose                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL` | Postgres connection string. Neon: *Dashboard → Connection Details*.     |
| `JWT_SECRET`   | Signs session cookies. Generate one (see below).                        |
| `PORT`         | API port. Defaults to `3000`; the Vite dev proxy expects this.           |
| `NODE_ENV`     | `development` or `production`.                                          |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`backend/.env` is gitignored — never commit real credentials.

> **On `sslmode`:** prefer `sslmode=verify-full`. `pg` already treats
> `sslmode=require` as an alias for `verify-full`, but warns about it on every
> boot; being explicit silences the warning and keeps the same behaviour in
> `pg` v9+.

### 3. Create the schema and demo data

```bash
npm run seed
```

This creates the tables, an admin account, and three sample companies with
stock. It is idempotent — safe to re-run.

### 4. Run it

```bash
npm run dev
```

Two processes start together:

- API → <http://localhost:3000>
- App → <http://localhost:5173> ← **open this one**

Vite proxies `/api/*` to the API, so both share an origin and the auth cookie
works without CORS.

### 5. Sign in

```
Username: admin
Password: admin123
```

Change this before exposing the app to anyone.

---

## Accounts

Companies are records whose stock we manage on their behalf — they are not
tenants and they do not sign in. Everyone who can sign in is staff, and every
account has the same access: all companies, all stock, all invoices, and the
ability to manage other accounts.

There is no role and no per-company scoping. `users` holds only `id`,
`username`, `password` and `created_at`.

**Account changes take effect immediately.** The session cookie carries only the
user id; the account is read from the database on every request, so deleting one
applies on its very next request rather than whenever its token would have
expired.

### Managing accounts

Accounts are provisioned from inside the app — there is no self-signup.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/users` | List accounts (never returns password hashes) |
| `POST /api/users` | Create an account: `username`, `password` |
| `PUT /api/users/:id` | Update; omit `password` to leave it unchanged |
| `DELETE /api/users/:id` | Remove an account |
| `POST /api/auth/change-password` | Any user changes their own password |

Passwords must be at least 8 characters and at most 72 bytes — bcrypt ignores
anything beyond 72, so longer values are rejected rather than silently truncated.

Two guards prevent locking everyone out: you cannot delete the account you are
signed in with, and you cannot delete the last remaining account.

Deleting a company also deletes its stock items. Companies that already have
invoices cannot be deleted at all.

---

## Scripts

Run from the repository root:

| Script                | Does                                                       |
| --------------------- | ---------------------------------------------------------- |
| `npm run install:all` | Install root + backend + frontend dependencies             |
| `npm run dev`         | Run API and frontend together (development)                |
| `npm run dev:api`     | API only, with nodemon reload                              |
| `npm run dev:client`  | Vite dev server only                                       |
| `npm run seed`        | Create schema, admin user, and demo data (idempotent)      |
| `npm run build`       | Build the frontend to `frontend/dist`                      |
| `npm start`           | Production: serve API **and** the built frontend on `PORT`  |
| `npm test`            | Run the API test suite (from `backend/`)                    |

---

## Tests

```bash
cd backend && npm test
```

Integration tests over the real HTTP API and a real Postgres — no mocks, because
the things most worth protecting here are transactional: stock deducted exactly
once, a failed finalize rolling back completely, a deleted account losing access
on its next request.

**Where they run.** Set `TEST_DATABASE_URL` and that database is used as-is.
Without it the tests fall back to `DATABASE_URL` but confine themselves to a
`stockflow_test` schema, created and dropped around each run. `public` is never
read or written. Neon's pooled endpoint rejects the connection parameter this
needs, so the fallback rewrites the host to the direct endpoint automatically.

**Speed.** The suite is latency-bound, not CPU-bound: against a hosted database
every request is a round trip, and the whole run takes a couple of minutes.
Point `TEST_DATABASE_URL` at a local Postgres for a fast edit-test loop.

**Concurrency tests.** Firing two requests at once does not reproduce a race
over a network — the second usually lands after the first has committed, and
the test passes whether or not the locking is correct. The finalize race test
instead holds a row lock from the test itself to force the interleaving. It was
checked by deleting the `FOR UPDATE` from the route: the naive version passed
three runs out of three, the current one fails as it should.

---

## Production

```bash
npm run build
NODE_ENV=production npm start
```

Everything is served from a single origin on `PORT`. In production the app
**refuses to start** without a real `JWT_SECRET`, and session cookies are
marked `Secure` (HTTPS only).

If `frontend/dist` does not exist, `npm start` runs the API only — build first.

---

## Project layout

```
backend/
  config.js            Loads and validates .env — required by every entry point
  server.js            Express app, async startup, graceful shutdown
  database/
    db.js              pg connection pool, schema, transaction helper
    seed.js            Idempotent seeder; also exports ensureAdminUser()
  middleware/
    auth.js            JWT cookie verification
    asyncHandler.js    Forwards async route rejections to the error handler
  routes/              auth, companies, items, invoices (+ PDF)

frontend/
  src/
    api.js             Fetch wrapper; same-origin, credentials included
    contexts/          Auth and toast providers
    components/        Layout, Modal, ConfirmDialog
    pages/             Login, Dashboard, Companies, Stock, Invoices
```

---

## How invoicing works

1. **Create** an invoice — saved as a `draft`. Stock is *not* touched.
2. **Finalize** it — inside one transaction, every line item's stock is
   deducted with a conditional `UPDATE … WHERE quantity >= ?`. If any line has
   insufficient stock the whole transaction rolls back and nothing changes.
3. **PDF** — generated on demand from the stored invoice.

Draft invoices can be deleted; finalized ones cannot.

---

## Notes

- Monetary and quantity columns are `DOUBLE PRECISION`, carried over from the
  previous SQLite schema. Fine for typical use, but not exact decimal
  arithmetic — `NUMERIC` would be the stricter choice for real accounting.
- `backend/database/inventory.db*` are leftovers from the SQLite implementation
  and are no longer read by the application.
