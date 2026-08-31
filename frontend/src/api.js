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

  // Users (platform admin only)
  getUsers: () => request('GET', '/api/users'),
  createUser: (d) => request('POST', '/api/users', d),
  updateUser: (id, d) => request('PUT', `/api/users/${id}`, d),
  deleteUser: (id) => request('DELETE', `/api/users/${id}`),

  // Companies
  getCompanies: () => request('GET', '/api/companies'),
  createCompany: (d) => request('POST', '/api/companies', d),
  updateCompany: (id, d) => request('PUT', `/api/companies/${id}`, d),
  deleteCompany: (id) => request('DELETE', `/api/companies/${id}`),

  // Items
  getItems: (cid) => request('GET', `/api/items/company/${cid}`),
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
};
