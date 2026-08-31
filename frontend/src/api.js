/**
 * Centralised API client.
 *
 * VITE_API_URL points at the backend when it is deployed on its own domain
 * (e.g. https://inventory-backend.vercel.app). Leave it unset to use relative
 * paths, which is right both for local development — where the Vite proxy
 * forwards /api to localhost:5001 — and for a single-origin deployment.
 *
 * Vite inlines this at BUILD time, not runtime: changing it on the host means
 * redeploying the frontend, not just restarting it.
 */
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

/** Absolute URL for a path, used for links the browser follows directly. */
export const apiUrl = (path) => `${API_BASE}${path}`;

/** Marker for a rejected-because-the-session-ended error. */
export const AUTH_EXPIRED = 'AUTH_EXPIRED';

/**
 * True when a rejection came from an expired or missing session.
 *
 * Session expiry is already handled globally: the request layer fires
 * `auth:expired`, AuthContext clears the user, and the router redirects to
 * /login. Callers use this to stay quiet about it rather than flashing a
 * meaningless "Unauthorized" toast on the way out.
 */
export const isAuthError = (err) => err?.code === AUTH_EXPIRED;

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    // 'include' rather than 'same-origin': the session cookie must travel to
    // the API even when it is on a different domain. Requires the API to send
    // Access-Control-Allow-Credentials and name this exact origin.
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(apiUrl(path), opts);
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'));
    const err = new Error(data.error || 'Your session has ended. Please log in again.');
    err.code = AUTH_EXPIRED;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  // Auth
  login: (u, p) => request('POST', '/api/auth/login', { username: u, password: p }),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request('GET', '/api/auth/me'),
  changePassword: (current, next) =>
    request('POST', '/api/auth/change-password', { current_password: current, new_password: next }),

  // Users (admin only)
  getUsers: () => request('GET', '/api/users'),
  createUser: (d) => request('POST', '/api/users', d),
  updateUser: (id, d) => request('PUT', `/api/users/${id}`, d),
  deleteUser: (id) => request('DELETE', `/api/users/${id}`),

  // Sub-admin company assignments (admin only)
  getUserCompanies:      (id) => request('GET', `/api/users/${id}/companies`),
  assignUserCompany:     (id, companyId) => request('POST', `/api/users/${id}/companies`, { company_id: companyId }),
  unassignUserCompany:   (id, companyId) => request('DELETE', `/api/users/${id}/companies/${companyId}`),

  // Companies
  getCompanies: () => request('GET', '/api/companies'),
  createCompany: (d) => request('POST', '/api/companies', d),
  updateCompany: (id, d) => request('PUT', `/api/companies/${id}`, d),
  deleteCompany: (id) => request('DELETE', `/api/companies/${id}`),

  // Items — backend paginates (default 200/page); a max-size request keeps
  // today's "load the whole catalog" behavior for any realistic catalog size.
  getItems: (cid) => request('GET', `/api/items/company/${cid}?limit=500`).then(d => d.items),
  createItem: (d) => request('POST', '/api/items', d),
  updateItem: (id, d) => request('PUT', `/api/items/${id}`, d),
  deleteItem: (id) => request('DELETE', `/api/items/${id}`),
  adjustItemQuantity: (id, d) => request('POST', `/api/items/${id}/adjust`, d),
  getItemMovements: (id) => request('GET', `/api/items/${id}/movements`),


  // Stock transactions
  stockIn:           (d) => request('POST', '/api/stock/in', d),
  stockOut:          (d) => request('POST', '/api/stock/out', d),
  getStockMovements: (companyId, page = 1, limit = 50) =>
    request('GET', `/api/stock/movements?company_id=${companyId}&page=${page}&limit=${limit}`),

  // Invoices — GST tax invoices, gated by the `invoicing` company feature
  getInvoices:     (companyId) => request('GET', `/api/invoices/company/${companyId}?limit=200`).then(d => d.invoices),
  getInvoiceStats: (companyId) => request('GET', `/api/invoices/company/${companyId}/summary`),
  getInvoice:      (id) => request('GET', `/api/invoices/${id}`),
  createInvoice:   (d) => request('POST', '/api/invoices', d),
  updateInvoice:   (id, d) => request('PUT', `/api/invoices/${id}`, d),
  finalizeInvoice: (id) => request('POST', `/api/invoices/${id}/finalize`),
  reverseInvoice:  (id) => request('POST', `/api/invoices/${id}/reverse`),
  deleteInvoice:   (id) => request('DELETE', `/api/invoices/${id}`),
  // A real link the browser follows, so it needs the absolute URL.
  pdfUrl: (id) => apiUrl(`/api/invoices/${id}/pdf`),

  // Feature flags — which optional modules a company has turned on (admin toggles)
  getFeatureRegistry:    () => request('GET', '/api/features'),
  getCompanyFeatures:    (companyId) => request('GET', `/api/features/company/${companyId}`),
  enableCompanyFeature:  (companyId, key) => request('POST', `/api/features/company/${companyId}/${key}`),
  disableCompanyFeature: (companyId, key) => request('DELETE', `/api/features/company/${companyId}/${key}`),
  // True if the signed-in user can reach at least one company with `key` on —
  // used to gate UI (like a nav link) that isn't itself scoped to one company.
  isFeatureEnabledAnywhere: (key) => request('GET', `/api/features/enabled/${key}`),
};
