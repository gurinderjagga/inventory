const express    = require('express');
const cookieParser = require('cookie-parser');
const path       = require('path');
const fs         = require('fs');
const { initDB } = require('./database/db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Initialize Database ──────────────────────────────────────
initDB();

// ── Global Middleware ────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── API Routes ───────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/items',     require('./routes/items'));
app.use('/api/invoices',  require('./routes/invoices'));

// ── Global Error Handler ─────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Static Frontend ──────────────────────────────────────────
// Serve React build (frontend/dist) in production.
// In development, Vite handles the frontend on port 5173.
const reactDist = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(reactDist)) {
  app.use(express.static(reactDist));
  app.get('*', (_req, res) => res.sendFile(path.join(reactDist, 'index.html')));
} else {
  // Fallback: serve old public/ folder or just explain dev mode
  const legacyPublic = path.join(__dirname, 'public');
  if (fs.existsSync(legacyPublic)) {
    app.use(express.static(legacyPublic));
    app.get('*', (_req, res) => res.sendFile(path.join(legacyPublic, 'index.html')));
  }
}

app.listen(PORT, () => {
  const reactBuilt = fs.existsSync(reactDist);
  console.log(`\n🚀  StockFlow API → http://localhost:${PORT}`);
  console.log(`⚛️   React frontend → ${reactBuilt ? `http://localhost:${PORT}` : 'http://localhost:5173  (run npm run dev:client)'}`);
  console.log(`📦  Database: ./database/inventory.db\n`);
});

