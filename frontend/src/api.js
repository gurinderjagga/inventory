/** Centralised API client — same-origin, credentials included */

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
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Auth
  login:  (u, p) => request('POST', '/api/auth/login', { username: u, password: p }),
  logout: ()     => request('POST', '/api/auth/logout'),
  me:     ()     => request('GET',  '/api/auth/me'),

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
