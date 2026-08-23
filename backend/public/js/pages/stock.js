/** Stock management page — company-scoped inventory */

import { api } from '../api.js';
import { openModal, closeModal, confirm } from '../components/modal.js';
import { toast } from '../components/toast.js';

let selectedCompany = null;
let allCompanies = [];
let currentItems = [];

export async function renderStock(params = {}) {
  const app = document.getElementById('app');
  document.getElementById('topbar').innerHTML = `
    <span class="topbar-title">Stock Management</span>
    <div class="topbar-actions" id="stock-topbar-actions"></div>
  `;

  app.innerHTML = `<div class="loading-page"><div class="spinner"></div><span>Loading…</span></div>`;

  try {
    allCompanies = await api.getCompanies();
    // If a company was pre-selected (e.g., from URL state)
    if (params.companyId) {
      selectedCompany = allCompanies.find(c => c.id == params.companyId) || null;
    }
    if (selectedCompany) {
      await showCompanyStock(selectedCompany);
    } else {
      showCompanyGrid();
    }
  } catch (err) {
    app.innerHTML = `<div class="empty-state"><i class="bi bi-exclamation-circle"></i><h3>Failed to load</h3><p>${err.message}</p></div>`;
  }
}

// ── Company Grid ────────────────────────────────────────────
function showCompanyGrid() {
  selectedCompany = null;
  const app = document.getElementById('app');
  document.getElementById('stock-topbar-actions').innerHTML = '';

  if (allCompanies.length === 0) {
    app.innerHTML = `
      <div class="empty-state page-enter">
        <i class="bi bi-building"></i>
        <h3>No companies yet</h3>
        <p>Add companies first from the Companies page.</p>
      </div>`;
    return;
  }

  app.innerHTML = `
    <div class="page-enter">
      <div class="page-header">
        <div class="page-header-text">
          <h2>Select a Company</h2>
          <p>Click a company to view and manage its stock inventory</p>
        </div>
      </div>
      <div class="company-cards-grid">
        ${allCompanies.map(c => {
          const low = c.low_stock_count || 0;
          return `
            <div class="company-card" data-company-id="${c.id}" role="button" tabindex="0" aria-label="View stock for ${c.name}">
              <div class="company-card-icon"><i class="bi bi-building-fill"></i></div>
              <h3>${c.name}</h3>
              <div class="company-card-meta">
                ${c.email || ''} ${c.phone ? '· ' + c.phone : ''}
              </div>
              <div class="company-card-stats">
                <div class="company-card-stat">
                  <span class="val" style="color:var(--text-accent)">${c.item_count || 0}</span>
                  <span class="lbl">Items</span>
                </div>
                <div class="company-card-stat">
                  <span class="val" style="color:${low > 0 ? 'var(--warning)' : 'var(--success)'}">${low}</span>
                  <span class="lbl">Low Stock</span>
                </div>
                <div class="company-card-stat">
                  <span class="val" style="color:var(--success);font-size:14px">$${Number(c.stock_value || 0).toFixed(0)}</span>
                  <span class="lbl">Value</span>
                </div>
              </div>
              ${low > 0 ? `<div style="margin-top:12px"><span class="badge badge-warning"><i class="bi bi-exclamation-triangle"></i> ${low} items low</span></div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  app.querySelectorAll('.company-card').forEach(card => {
    const go = () => {
      const company = allCompanies.find(c => c.id == card.dataset.companyId);
      if (company) showCompanyStock(company);
    };
    card.addEventListener('click', go);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') go(); });
  });
}

// ── Company Stock Items ─────────────────────────────────────
async function showCompanyStock(company) {
  selectedCompany = company;
  const app = document.getElementById('app');

  document.getElementById('stock-topbar-actions').innerHTML = `
    <button class="btn btn-secondary" id="back-to-companies">
      <i class="bi bi-arrow-left"></i> All Companies
    </button>
    <div class="search-wrap">
      <i class="bi bi-search"></i>
      <input type="text" id="item-search" placeholder="Search items…" />
    </div>
    <button class="btn btn-primary" id="add-item-btn">
      <i class="bi bi-plus-lg"></i> Add Item
    </button>
  `;

  app.innerHTML = `<div class="loading-page"><div class="spinner"></div><span>Loading items…</span></div>`;

  document.getElementById('back-to-companies').addEventListener('click', async () => {
    allCompanies = await api.getCompanies();
    showCompanyGrid();
  });

  document.getElementById('add-item-btn').addEventListener('click', () => openItemModal());

  document.getElementById('item-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    renderItemsTable(currentItems.filter(i => i.name.toLowerCase().includes(q) || (i.sku || '').toLowerCase().includes(q)));
  });

  try {
    currentItems = await api.getItems(company.id);
    renderItemsTable(currentItems);
  } catch (err) {
    app.innerHTML = `<div class="empty-state"><i class="bi bi-exclamation-circle"></i><h3>Failed to load items</h3><p>${err.message}</p></div>`;
  }
}

// ── Items Table ─────────────────────────────────────────────
function renderItemsTable(items) {
  const app = document.getElementById('app');

  if (items.length === 0) {
    app.innerHTML = `
      <div class="page-enter">
        <div class="breadcrumb">
          <span>Stock</span>
          <i class="bi bi-chevron-right"></i>
          <span class="current">${selectedCompany.name}</span>
        </div>
        <div class="empty-state">
          <i class="bi bi-box-seam"></i>
          <h3>No items yet</h3>
          <p>Add your first stock item using the button above.</p>
        </div>
      </div>`;
    return;
  }

  app.innerHTML = `
    <div class="page-enter">
      <div class="breadcrumb">
        <span>Stock</span>
        <i class="bi bi-chevron-right"></i>
        <span class="current">${selectedCompany.name}</span>
      </div>
      <div class="page-header" style="margin-bottom:16px">
        <div class="page-header-text">
          <h2>${selectedCompany.name}</h2>
          <p>${items.length} item${items.length !== 1 ? 's' : ''} in inventory</p>
        </div>
      </div>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Item Name</th>
              <th>SKU</th>
              <th>Unit</th>
              <th>Stock Level</th>
              <th>Unit Price</th>
              <th>Stock Value</th>
              <th>Status</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(item => {
              const pct = item.low_stock_threshold > 0
                ? Math.min(100, (item.quantity / (item.low_stock_threshold * 3)) * 100)
                : 100;
              const isLow = item.quantity <= item.low_stock_threshold;
              const barColor = isLow ? 'var(--warning)' : item.quantity > item.low_stock_threshold * 2 ? 'var(--success)' : 'var(--info)';

              return `
                <tr>
                  <td style="font-weight:600">${item.name}</td>
                  <td style="font-family:monospace;font-size:12px;color:var(--text-accent)">${item.sku || '—'}</td>
                  <td>${item.unit}</td>
                  <td>
                    <div class="stock-bar-wrap">
                      <span style="font-weight:600;min-width:32px">${item.quantity}</span>
                      <div class="stock-bar">
                        <div class="stock-bar-fill" style="width:${pct}%;background:${barColor}"></div>
                      </div>
                    </div>
                  </td>
                  <td>$${parseFloat(item.unit_price).toFixed(2)}</td>
                  <td style="font-weight:600;color:var(--success)">$${(item.quantity * item.unit_price).toFixed(2)}</td>
                  <td>${isLow
                    ? `<span class="badge badge-warning"><i class="bi bi-exclamation-triangle"></i> Low</span>`
                    : `<span class="badge badge-success"><i class="bi bi-check-circle"></i> OK</span>`}
                  </td>
                  <td>
                    <div class="td-actions">
                      <button class="btn btn-secondary btn-sm" data-edit="${item.id}" title="Edit item">
                        <i class="bi bi-pencil"></i>
                      </button>
                      <button class="btn btn-danger btn-sm" data-delete="${item.id}" data-name="${item.name}" title="Delete item">
                        <i class="bi bi-trash3"></i>
                      </button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  app.querySelectorAll('[data-edit]').forEach(btn => {
    const item = currentItems.find(i => i.id == btn.dataset.edit);
    btn.addEventListener('click', () => openItemModal(item));
  });

  app.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteItem(btn.dataset.delete, btn.dataset.name));
  });
}

// ── Add / Edit Item Modal ───────────────────────────────────
function openItemModal(item = null) {
  const isEdit = !!item;
  const modal = openModal({
    title: isEdit ? `Edit: ${item.name}` : 'Add Stock Item',
    body: `
      <div class="form-group">
        <label for="i-name">Item Name <span style="color:var(--danger)">*</span></label>
        <input id="i-name" type="text" placeholder="e.g. HDMI Cable 2m" value="${item?.name || ''}" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="i-sku">SKU / Code</label>
          <input id="i-sku" type="text" placeholder="e.g. TC-001" value="${item?.sku || ''}" />
        </div>
        <div class="form-group">
          <label for="i-unit">Unit</label>
          <select id="i-unit">
            ${['pcs', 'boxes', 'reams', 'kg', 'liters', 'sets', 'packs', 'rolls', 'pairs'].map(u =>
              `<option value="${u}" ${(item?.unit || 'pcs') === u ? 'selected' : ''}>${u}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="i-qty">Quantity <span style="color:var(--danger)">*</span></label>
          <input id="i-qty" type="number" min="0" step="0.01" placeholder="0" value="${item?.quantity ?? ''}" />
        </div>
        <div class="form-group">
          <label for="i-price">Unit Price ($) <span style="color:var(--danger)">*</span></label>
          <input id="i-price" type="number" min="0" step="0.01" placeholder="0.00" value="${item?.unit_price ?? ''}" />
        </div>
      </div>
      <div class="form-group">
        <label for="i-threshold">Low Stock Threshold</label>
        <input id="i-threshold" type="number" min="0" placeholder="10" value="${item?.low_stock_threshold ?? 10}" />
        <small style="color:var(--text-muted);font-size:11px;margin-top:4px;display:block">Alert when quantity falls at or below this value</small>
      </div>
      <div id="i-error" class="login-error hidden"><i class="bi bi-exclamation-circle"></i><span id="i-error-msg"></span></div>
    `,
    footer: `
      <button class="btn btn-secondary" id="i-cancel">Cancel</button>
      <button class="btn btn-primary" id="i-save">
        <i class="bi bi-check-lg"></i> ${isEdit ? 'Save Changes' : 'Add Item'}
      </button>
    `,
  });

  modal.querySelector('#i-cancel').addEventListener('click', closeModal);

  modal.querySelector('#i-save').addEventListener('click', async () => {
    const name      = modal.querySelector('#i-name').value.trim();
    const sku       = modal.querySelector('#i-sku').value.trim();
    const unit      = modal.querySelector('#i-unit').value;
    const quantity  = parseFloat(modal.querySelector('#i-qty').value);
    const unitPrice = parseFloat(modal.querySelector('#i-price').value);
    const threshold = parseFloat(modal.querySelector('#i-threshold').value) || 10;
    const errEl     = modal.querySelector('#i-error');
    const errMsg    = modal.querySelector('#i-error-msg');

    if (!name) { errMsg.textContent = 'Item name is required.'; errEl.classList.remove('hidden'); return; }
    if (isNaN(quantity) || quantity < 0) { errMsg.textContent = 'Quantity must be a non-negative number.'; errEl.classList.remove('hidden'); return; }
    if (isNaN(unitPrice) || unitPrice < 0) { errMsg.textContent = 'Unit price must be a non-negative number.'; errEl.classList.remove('hidden'); return; }

    const saveBtn = modal.querySelector('#i-save');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Saving…';

    try {
      if (isEdit) {
        await api.updateItem(item.id, { name, sku, unit, quantity, unit_price: unitPrice, low_stock_threshold: threshold });
        toast.success('Item updated.');
      } else {
        await api.createItem({ company_id: selectedCompany.id, name, sku, unit, quantity, unit_price: unitPrice, low_stock_threshold: threshold });
        toast.success('Item added to inventory.');
      }
      closeModal();
      currentItems = await api.getItems(selectedCompany.id);
      renderItemsTable(currentItems);
    } catch (err) {
      errMsg.textContent = err.message;
      errEl.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<i class="bi bi-check-lg"></i> ${isEdit ? 'Save Changes' : 'Add Item'}`;
    }
  });

  modal.querySelector('#i-name').focus();
}

// ── Delete Item ─────────────────────────────────────────────
async function deleteItem(id, name) {
  const ok = await confirm({
    title: 'Delete Item',
    message: `Remove <strong>${name}</strong> from ${selectedCompany.name}'s inventory? This cannot be undone.`,
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteItem(id);
    toast.success(`"${name}" removed.`);
    currentItems = await api.getItems(selectedCompany.id);
    renderItemsTable(currentItems);
  } catch (err) {
    toast.error(err.message);
  }
}
