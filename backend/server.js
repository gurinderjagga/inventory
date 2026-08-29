const config     = require('./config');   // must load first — populates process.env
const express    = require('express');
const cookieParser = require('cookie-parser');
const path       = require('path');
const fs         = require('fs');
const { initDB, closeDB } = require('./database/db');
const { ensureAdminUser, DEFAULT_ADMIN } = require('./database/seed');

const app  = express();
const PORT = config.PORT;

// ── Global Middleware ────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── API Routes ───────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/items',     require('./routes/items'));
app.use('/api/invoices',  require('./routes/invoices'));

// ── Unknown API Routes ───────────────────────────────────────
// Must sit after the API routes but before the SPA fallback, so an unknown
// endpoint answers with JSON the client can parse rather than an HTML page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such API endpoint: ${req.method} /api${req.path.replace(/\/$/, '')}` });
});

// ── Static Frontend ──────────────────────────────────────────
// Production: serve the built React bundle from frontend/dist.
// Development: Vite serves the frontend on :5173 and proxies /api here, so
// there is nothing for Express to serve — say so rather than serving something
// stale, which would look like a working app built from the wrong source.
const reactDist  = path.join(__dirname, '..', 'frontend', 'dist');
const reactBuilt = fs.existsSync(reactDist);

if (reactBuilt) {
  app.use(express.static(reactDist));

  // Client-side routes (/companies, /stock, …) are served the SPA shell so a
  // hard refresh works. Unmatched /api paths never reach here — the JSON 404
  // handler above already answered them.
  app.get('*', (_req, res) => {
    res.sendFile(path.join(reactDist, 'index.html'));
  });
} else {
  app.get('*', (_req, res) => {
    res.status(503).send(
      '<!doctype html><meta charset="utf-8">' +
      '<title>StockFlow — frontend not built</title>' +
      '<div style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem">' +
      '<h1 style="font-size:1.25rem">Frontend not built</h1>' +
      '<p>The API is running, but there is no <code>frontend/dist</code> to serve.</p>' +
      '<p><strong>In development</strong> open <a href="http://localhost:5173">http://localhost:5173</a> — ' +
      'Vite serves the app there and proxies <code>/api</code> to this server. ' +
      'Start both with <code>npm run dev</code>.</p>' +
      '<p><strong>For production</strong> run <code>npm run build</code>, then restart.</p>' +
      '</div>'
    );
  });
}

// ── Global Error Handler ─────────────────────────────────────
// Registered last so it can catch errors from every route and middleware
// above, including the static/SPA layer.
//
// Postgres SQLSTATEs handled as a backstop. Routes generally validate first and
// return a better-worded error; these only fire if something slipped past, and
// exist so a constraint violation is never reported as a server fault.
const PG_STATUS = {
  '23505': [409, 'That value is already taken'],           // unique_violation
  '23503': [409, 'That record is referenced by other data'], // foreign_key_violation
  '23502': [400, 'A required field was missing'],            // not_null_violation
  '22P02': [400, 'A value in the request was not valid'],    // invalid_text_representation
  '22003': [400, 'A number in the request was out of range'],// numeric_value_out_of_range
};

app.use((err, req, res, _next) => {
  // Errors we raised deliberately carry a status and a message safe to show.
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }

  const mapped = PG_STATUS[err.code];
  if (mapped) {
    console.error(`Database constraint error (${err.code}) on ${req.method} ${req.originalUrl}:`, err.message);
    return res.status(mapped[0]).json({ error: mapped[1] });
  }

  // Anything else is unexpected: log it in full, tell the client nothing.
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Connect to Postgres and prepare the schema before accepting traffic.
 * Serving requests against an unreachable database would only produce 500s,
 * so a failure here is fatal rather than something to retry silently.
 */
async function start() {
  try {
    await initDB();
  } catch (err) {
    console.error('\n❌  Could not connect to the database.');
    console.error(`    ${err.message}`);
    console.error('    Check DATABASE_URL in backend/.env, then try again.\n');
    await closeDB().catch(() => {});
    process.exit(1);
  }

  // First boot against an empty database: create the admin account, otherwise
  // there is no way to log in and no indication why.
  let createdAdmin = false;
  try {
    createdAdmin = await ensureAdminUser();
  } catch (err) {
    console.error('⚠️   Could not verify the admin user:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`\n🚀  StockFlow API → http://localhost:${PORT}`);
    console.log(`⚛️   React frontend → ${reactBuilt ? `http://localhost:${PORT}` : 'http://localhost:5173  (run npm run dev:client)'}`);
    console.log(`📦  Database: Postgres (${config.NODE_ENV})`);
    if (createdAdmin) {
      console.log(`\n👤  Created default admin → ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}`);
      console.log(`    Run "npm run seed" to add demo companies and stock.`);
    }
    console.log('');
  });
}

// Release pooled connections so Neon does not hold them open after we exit.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n${signal} received — shutting down.`);
    await closeDB().catch(() => {});
    process.exit(0);
  });
}

start();
