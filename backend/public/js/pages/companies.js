/** Companies management page */

import { api } from '../api.js';
import { openModal, closeModal, confirm } from '../components/modal.js';
import { toast } from '../components/toast.js';

export async function renderCompanies() {
  const app = document.getElementById('app');
  document.getElementById('topbar').innerHTML = `
    <span class="topbar-title">Companies</span>
    <div class="topbar-actions">
      <div class="search-wrap">
        <i class="bi bi-search"></i>
        <input type="text" id="company-search" placeholder="Search companies…" />
      </div>
      <button class="btn btn-primary" id="add-company-btn">
        <i class="bi bi-plus-lg"></i> Add Company
      </button>
    </div>
  `;

  app.innerHTML = `<div class="loading-page"><div class="spinner"></div><span>Loading companies…</span></div>`;

  let companies = [];

  try {
    companies = await api.getCompanies();
    render(companies);
  } catch (err) {
    app.innerHTML = `<div class="empty-state"><i class="bi bi-exclamation-circle"></i><h3>Failed to load</h3><p>${err.message}</p></div>`;
  }

  // ── Bind topbar add button ────────────────────────────────
  document.getElementById('add-company-btn').addEventListener('click', () => openCompanyModal());
  document.getElementById('company-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    render(companies.filter(c => c.name.toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q)));
  });

  // ── Render table ──────────────────────────────────────────
  function render(list) {
    app.innerHTML = list.length === 0 ? `
      <div class="empty-state page-enter">
        <i class="bi bi-building"></i>
        <h3>No companies found</h3>
        <p>Add your first company using the button above.</p>
      </div>
    ` : `
      <div class="page-enter">
        <div class="page-header">
          <div class="page-header-text">
            <h2>All Companies</h2>
            <p>${list.length} ${list.length === 1 ? 'company' : 'companies'} registered</p>
          </div>
        </div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Company Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Items</th>
                <th>Low Stock</th>
                <th>Stock Value</th>
                <th style="text-align:right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(c => `
                <tr>
                  <td>
                    <div style="display:flex;align-items:center;gap:10px">
                      <div style="width:32px;height:32px;background:rgba(99,102,241,0.12);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">🏢</div>
                      <span style="font-weight:600">${c.name}</span>
                    </div>
                  </td>
                  <td style="color:var(--text-secondary)">${c.email || '—'}</td>
                  <td style="color:var(--text-secondary)">${c.phone || '—'}</td>
                  <td><span class="badge badge-neutral">${c.item_count || 0}</span></td>
                  <td>
                    ${(c.low_stock_count || 0) > 0
                      ? `<span class="badge badge-warning"><i class="bi bi-exclamation-triangle"></i> ${c.low_stock_count}</span>`
                      : `<span class="badge badge-success"><i class="bi bi-check"></i> OK</span>`}
                  </td>
                  <td style="font-weight:600">$${Number(c.stock_value || 0).toFixed(2)}</td>
                  <td>
                    <div class="td-actions">
                      <button class="btn btn-secondary btn-sm" data-edit="${c.id}" title="Edit">
                        <i class="bi bi-pencil"></i> Edit
                      </button>
                      <button class="btn btn-danger btn-sm" data-delete="${c.id}" data-name="${c.name}" title="Delete">
                        <i class="bi bi-trash3"></i>
                      </button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Edit buttons
    app.querySelectorAll('[data-edit]').forEach(btn => {
      const company = companies.find(c => c.id == btn.dataset.edit);
      btn.addEventListener('click', () => openCompanyModal(company));
    });

    // Delete buttons
    app.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteCompany(btn.dataset.delete, btn.dataset.name));
    });
  }

  // ── Add / Edit Modal ──────────────────────────────────────
  function openCompanyModal(company = null) {
    const isEdit = !!company;
    const modal = openModal({
      title: isEdit ? 'Edit Company' : 'Add New Company',
      body: `
        <div class="form-group">
          <label for="c-name">Company Name <span style="color:var(--danger)">*</span></label>
          <input id="c-name" type="text" placeholder="e.g. Acme Corp" value="${company?.name || ''}" required />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="c-email">Email</label>
            <input id="c-email" type="email" placeholder="contact@company.com" value="${company?.email || ''}" />
          </div>
          <div class="form-group">
            <label for="c-phone">Phone</label>
            <input id="c-phone" type="tel" placeholder="+1-555-0000" value="${company?.phone || ''}" />
          </div>
        </div>
        <div class="form-group">
          <label for="c-address">Address</label>
          <textarea id="c-address" placeholder="Street address, City, State">${company?.address || ''}</textarea>
        </div>
        <div id="c-error" class="login-error hidden"><i class="bi bi-exclamation-circle"></i><span id="c-error-msg"></span></div>
      `,
      footer: `
        <button class="btn btn-secondary" id="c-cancel">Cancel</button>
        <button class="btn btn-primary" id="c-save">
          <i class="bi bi-check-lg"></i> ${isEdit ? 'Save Changes' : 'Create Company'}
        </button>
      `,
    });

    modal.querySelector('#c-cancel').addEventListener('click', closeModal);

    modal.querySelector('#c-save').addEventListener('click', async () => {
      const name    = modal.querySelector('#c-name').value.trim();
      const email   = modal.querySelector('#c-email').value.trim();
      const phone   = modal.querySelector('#c-phone').value.trim();
      const address = modal.querySelector('#c-address').value.trim();
      const errEl   = modal.querySelector('#c-error');
      const errMsg  = modal.querySelector('#c-error-msg');

      if (!name) {
        errMsg.textContent = 'Company name is required.';
        errEl.classList.remove('hidden');
        return;
      }

      const saveBtn = modal.querySelector('#c-save');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Saving…';

      try {
        if (isEdit) {
          await api.updateCompany(company.id, { name, email, phone, address });
          toast.success('Company updated successfully.');
        } else {
          await api.createCompany({ name, email, phone, address });
          toast.success('Company created successfully.');
        }
        closeModal();
        companies = await api.getCompanies();
        render(companies);
      } catch (err) {
        errMsg.textContent = err.message;
        errEl.classList.remove('hidden');
        saveBtn.disabled = false;
        saveBtn.innerHTML = `<i class="bi bi-check-lg"></i> ${isEdit ? 'Save Changes' : 'Create Company'}`;
      }
    });

    modal.querySelector('#c-name').focus();
  }

  // ── Delete ────────────────────────────────────────────────
  async function deleteCompany(id, name) {
    const ok = await confirm({
      title: 'Delete Company',
      message: `Are you sure you want to delete <strong>${name}</strong>? All associated stock items will also be permanently deleted. This cannot be undone.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteCompany(id);
      toast.success(`"${name}" deleted.`);
      companies = await api.getCompanies();
      render(companies);
    } catch (err) {
      toast.error(err.message);
    }
  }
}
