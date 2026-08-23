/**
 * app.js — SPA entry point
 * Handles authentication state, routing, and page rendering.
 */

import { api } from './api.js';
import { renderSidebar, updateSidebarActive } from './components/sidebar.js';
import { renderLogin } from './pages/login.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderCompanies } from './pages/companies.js';
import { renderStock } from './pages/stock.js';
import { renderInvoices } from './pages/invoices.js';

// ── App State ─────────────────────────────────────────────────
let currentUser = null;
let currentPage = 'dashboard';

// ── Elements ──────────────────────────────────────────────────
const shell       = document.getElementById('shell');
const authWrapper = document.getElementById('auth-wrapper');

// ── Route Map ─────────────────────────────────────────────────
const PAGES = {
  dashboard: renderDashboard,
  companies: renderCompanies,
  stock:     renderStock,
  invoices:  renderInvoices,
};

// ── Navigate to a page ────────────────────────────────────────
async function navigate(page) {
  if (!PAGES[page]) page = 'dashboard';
  currentPage = page;

  updateSidebarActive(page);
  window.location.hash = page;

  await PAGES[page]();
}

// ── Show authenticated shell ──────────────────────────────────
function showShell(username) {
  authWrapper.classList.add('hidden');
  shell.classList.remove('hidden');

  renderSidebar(currentPage, username, navigate);

  // Read current hash or default to dashboard
  const hash = window.location.hash.replace('#', '');
  navigate(hash && PAGES[hash] ? hash : 'dashboard');
}

// ── Show login screen ─────────────────────────────────────────
function showLogin() {
  shell.classList.add('hidden');
  authWrapper.classList.remove('hidden');
  currentUser = null;

  renderLogin((username) => {
    currentUser = username;
    showShell(username);
  });
}

// ── Handle expired session ────────────────────────────────────
window.addEventListener('auth:expired', () => {
  showLogin();
});

// ── Hash-based routing ────────────────────────────────────────
window.addEventListener('hashchange', () => {
  if (!currentUser) return;
  const page = window.location.hash.replace('#', '');
  if (PAGES[page] && page !== currentPage) navigate(page);
});

// ── Bootstrap ─────────────────────────────────────────────────
async function init() {
  try {
    const user = await api.me();
    currentUser = user.username;
    showShell(user.username);
  } catch (_) {
    // Not authenticated
    showLogin();
  }
}

init();
