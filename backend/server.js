const config = require('./config');   // must load first — populates process.env
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { initDB, closeDB } = require('./database/db');
const { apiLimiter } = require('./middleware/rateLimit');
const { ensureAdminUser, DEFAULT_ADMIN } = require('./database/seed');

const app = express();
const PORT = config.PORT;

// ── Behind a proxy ───────────────────────────────────────────
// Vercel and most hosts terminate TLS in front of the app, so req.ip is the
// proxy unless we say otherwise — which would make the rate limiter count every
// visitor as one client. Trusting exactly one hop reads the last entry of
// X-Forwarded-For; trusting `true` would take the first, which the client can
// forge to dodge the limiter entirely.
app.set('trust proxy', 1);

// ── Security headers ─────────────────────────────────────────
// HSTS, X-Content-Type-Options, Referrer-Policy and friends.
//
// The CSP is written out rather than left at helmet's default because this
// server also serves the built React app, whose index.html pulls Inter from
// Google Fonts — the default policy would block the stylesheet and the font
// files and leave the UI in a fallback face.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],
      // Vite inlines critical styles, and several components set style="".
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc:      ["'self'", 'data:', 'blob:'],
      // The API may be on another origin; the allowlist decides who may call it.
      connectSrc:  ["'self'", ...config.CORS_ORIGINS],
      objectSrc:   ["'none'"],
      frameAncestors: ["'none'"],
      baseUri:     ["'self'"],
      formAction:  ["'self'"],
      // Conditional spread avoids passing null to helmet, which generates a
      // warning on every request in development. In production the directive
      // tells browsers to upgrade any remaining http:// sub-resource requests.
      ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  // The PDF endpoint is opened in a new tab from the frontend, which is a
  // different origin in the split deployment. same-origin would block it.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // Opting out of Chrome's origin isolation, which the split deployment does
  // not need and which complicates opening the PDF in a new window.
  crossOriginOpenerPolicy: false,
}));

// ── Compression ──────────────────────────────────────────────
// gzip/brotli every compressible response (JSON API payloads and the built
// SPA's JS/CSS) — no correctness risk, and the default filter already skips
// content that doesn't benefit (images, PDFs, already-compressed types).
app.use(compression());

// ── CORS ─────────────────────────────────────────────────────
// Only mounted when the frontend lives on another origin. `credentials: true`
// is what lets the browser send the session cookie; it cannot be combined with
// a wildcard origin, hence the explicit allowlist.
if (config.isCrossSite) {
  app.use(cors({
    origin(origin, callback) {
      // No Origin header: same-origin navigations, curl, health checks.
      if (!origin) return callback(null, true);
      if (config.CORS_ORIGINS.includes(origin.replace(/\/$/, ''))) {
        return callback(null, true);
      }
      // Reject without throwing: the request proceeds without CORS headers,
      // so the browser blocks it and the log stays quiet under scanning.
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  }));
  console.log(`🔓  CORS enabled for: ${config.CORS_ORIGINS.join(', ')}`);
}

/**
 * Ensure the schema exists and the admin account is present.
 *
 * Memoised, so it runs at most once per process. A long-running server awaits
 * it before listening; a serverless instance awaits it on its first request
 * and every later request on that instance resolves instantly.
 *
 * The promise is cleared on failure so the next request retries rather than
 * caching a rejection for the life of the instance.
 */
// Serverless instances pay the schema check on every cold start (~2-3s against
// a remote database). Set SKIP_DB_INIT=true once the schema is in place — the
// seeder applies it — to trade that for a fast first request. Leave it unset
// and the app is self-provisioning against an empty database.
const SKIP_DB_INIT = process.env.SKIP_DB_INIT === 'true';

let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (SKIP_DB_INIT) return false;
      await initDB();
      try {
        return await ensureAdminUser();
      } catch (err) {
        console.error('⚠️   Could not verify the admin user:', err.message);
        return false;
      }
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

// ── Global Middleware ────────────────────────────────────────
// JSON only, deliberately.
//
// With SameSite=None the cookie rides along on cross-site requests, so CSRF
// becomes a live concern. A cross-site <form> can only send url-encoded,
// multipart, or plain-text bodies, and those are "simple requests" that browsers
// fire WITHOUT a preflight — meaning CORS never gets the chance to block them.
// Accepting application/json only forces a preflight on every state-changing
// call, which the allowlist above then rejects. Re-adding express.urlencoded
// would reopen that hole; nothing here posts form bodies.
app.use(express.json());
app.use(cookieParser());

// Block requests until the schema is ready. A no-op once resolved, so this
// costs nothing after the first request on any given instance.
app.use((req, res, next) => {
  ensureReady().then(() => next()).catch(next);
});

// ── API Routes ───────────────────────────────────────────────
// The broad limiter covers /api only — the SPA's own assets are static files
// and a hard refresh should never be throttled.
app.use('/api', apiLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/items', require('./routes/items'));
app.use('/api/stock', require('./routes/stock'));
app.use('/api/features', require('./routes/features'));
app.use('/api/invoices', require('./routes/invoices'));

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
const reactDist = path.join(__dirname, '..', 'frontend', 'dist');
const reactBuilt = fs.existsSync(reactDist);

if (reactBuilt) {
  // Hashed assets (JS chunks, CSS, fonts) get a far-future Cache-Control so
  // returning visitors load them from disk. Vite appends a content hash to
  // every filename it emits, so a changed file always has a new URL — safe to
  // cache indefinitely. index.html is deliberately kept un-cached (no-store)
  // so the browser always fetches the latest shell and its new asset URLs.
  app.use(express.static(reactDist, {
    maxAge: '1y',
    immutable: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  }));

  // Client-side routes (/companies, /stock, …) are served the SPA shell so a
  // hard refresh works. Unmatched /api paths never reach here — the JSON 404
  // handler above already answered them.
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
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
  let createdAdmin = false;
  try {
    // Same readiness step the request gate uses — done up front here so a bad
    // DATABASE_URL fails loudly at boot instead of on the first request.
    createdAdmin = await ensureReady();
  } catch (err) {
    console.error('\n❌  Could not connect to the database.');
    console.error(`    ${err.message}`);
    console.error('    Check DATABASE_URL in backend/.env, then try again.\n');
    await closeDB().catch(() => { });
    process.exit(1);
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
// Only meaningful for a long-running process; serverless instances are frozen
// rather than signalled, and Neon reaps their idle connections itself.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n${signal} received — shutting down.`);
    await closeDB().catch(() => { });
    process.exit(0);
  });
}

// Bind a port only when run directly (`node server.js`, nodemon, a container).
// When required — as the serverless entry point in api/index.js does — the app
// is handed to the platform, which owns the listening socket. Calling listen()
// there would be wrong and, on some platforms, fatal.
if (require.main === module) {
  start();
}

module.exports = app;
