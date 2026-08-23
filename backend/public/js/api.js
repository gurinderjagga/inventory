/**
 * api.js — Centralised fetch wrapper.
 * All requests send credentials (cookies) automatically.
 * On 401 the user is redirected to login.
 */

const BASE = '';   // same origin

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(BASE + path, opts);

  if (res.status === 401) {
    // Session expired — let app.js handle redirect
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Unauthorized');
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data;
}

export const api = {
  // ── Auth ─────────────────────────────────────────────────
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  logout: ()                  => request('POST', '/api/auth/logout'),
  me:    ()                   => request('GET', '/api/auth/me'),

  // ── Companies ────────────────────────────────────────────
  getCompanies:    ()         => request('GET', '/api/companies'),
  getCompany:      (id)       => request('GET', `/api/companies/${id}`),
  createCompany:   (data)     => request('POST', '/api/companies', data),
  updateCompany:   (id, data) => request('PUT', `/api/companies/${id}`, data),
  deleteCompany:   (id)       => request('DELETE', `/api/companies/${id}`),

  // ── Items ─────────────────────────────────────────────────
  getItems:        (companyId)      => request('GET', `/api/items/company/${companyId}`),
  getItem:         (id)             => request('GET', `/api/items/${id}`),
  createItem:      (data)           => request('POST', '/api/items', data),
  updateItem:      (id, data)       => request('PUT', `/api/items/${id}`, data),
  deleteItem:      (id)             => request('DELETE', `/api/items/${id}`),

  // ── Invoices ──────────────────────────────────────────────
  getInvoices:     ()          => request('GET', '/api/invoices'),
  getInvoice:      (id)        => request('GET', `/api/invoices/${id}`),
  createInvoice:   (data)      => request('POST', '/api/invoices', data),
  finalizeInvoice: (id)        => request('POST', `/api/invoices/${id}/finalize`),
  deleteInvoice:   (id)        => request('DELETE', `/api/invoices/${id}`),
  getInvoiceStats: ()          => request('GET', '/api/invoices/summary/stats'),
  pdfUrl:          (id)        => `/api/invoices/${id}/pdf`,
};
