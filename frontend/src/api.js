/** Centralised API client — same-origin, credentials included */

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
    credentials: 'same-origin',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(path, opts);
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
  login:  (u, p) => request('POST', '/api/auth/login', { username: u, password: p }),
  logout: ()     => request('POST', '/api/auth/logout'),
  me:     ()     => request('GET',  '/api/auth/me'),
  changePassword: (current, next) =>
    request('POST', '/api/auth/change-password', { current_password: current, new_password: next }),

  // Users (platform admin only)
  getUsers:   ()      => request('GET',    '/api/users'),
  createUser: (d)     => request('POST',   '/api/users', d),
  updateUser: (id, d) => request('PUT',    `/api/users/${id}`, d),
  deleteUser: (id)    => request('DELETE', `/api/users/${id}`),

  // Companies
  getCompanies:  ()        => request('GET',    '/api/companies'),
  createCompany: (d)       => request('POST',   '/api/companies', d),
  updateCompany: (id, d)   => request('PUT',    `/api/companies/${id}`, d),
  deleteCompany: (id)      => request('DELETE', `/api/companies/${id}`),

  // Items
  getItems:   (cid)      => request('GET',    `/api/items/company/${cid}`),
  createItem: (d)        => request('POST',   '/api/items', d),
  updateItem: (id, d)    => request('PUT',    `/api/items/${id}`, d),
  deleteItem: (id)       => request('DELETE', `/api/items/${id}`),

  // Invoices
  getInvoices:     ()     => request('GET',  '/api/invoices'),
  getInvoice:      (id)   => request('GET',  `/api/invoices/${id}`),
  createInvoice:   (d)    => request('POST', '/api/invoices', d),
  finalizeInvoice: (id)   => request('POST', `/api/invoices/${id}/finalize`),
  deleteInvoice:   (id)   => request('DELETE', `/api/invoices/${id}`),
  getInvoiceStats: ()     => request('GET',  '/api/invoices/summary/stats'),
  pdfUrl:          (id)   => `/api/invoices/${id}/pdf`,
};
