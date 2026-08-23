/** Invoice list + creation page */

import { api } from '../api.js';
import { openModal, closeModal, confirm } from '../components/modal.js';
import { toast } from '../components/toast.js';

export async function renderInvoices() {
  const app = document.getElementById('app');
  document.getElementById('topbar').innerHTML = `
    <span class="topbar-title">Invoices</span>
    <div class="topbar-actions">
      <button class="btn btn-primary" id="new-invoice-btn">
        <i class="bi bi-plus-lg"></i> New Invoice
      </button>
    </div>
  `;

  app.innerHTML = `<div class="loading-page"><div class="spinner"></div><span>Loading invoices…</span></div>`;

  let invoices = [];

  async function load() {
    invoices = await api.getInvoices();
    renderList(invoices);
  }

  try {
    await load();
  } catch (err) {
    app.innerHTML = `<div class="empty-state"><i class="bi bi-exclamation-circle"></i><h3>Failed to load invoices</h3><p>${err.message}</p></div>`;
    return;
  }

  document.getElementById('new-invoice-btn').addEventListener('click', () => openNewInvoiceModal(load));

  // ── Invoice List ──────────────────────────────────────────
  function renderList(list) {
    if (list.length === 0) {
      app.innerHTML = `
        <div class="empty-state page-enter">
          <i class="bi bi-receipt"></i>
          <h3>No invoices yet</h3>
          <p>Create your first invoice using the button above.</p>
        </div>`;
      return;
    }

    app.innerHTML = `
      <div class="page-enter">
        <div class="page-header">
          <div class="page-header-text">
            <h2>All Invoices</h2>
            <p>${list.length} invoice${list.length !== 1 ? 's' : ''}</p>
          </div>
          <div class="flex gap-2 items-center">
            <div class="search-wrap">
              <i class="bi bi-search"></i>
              <input type="text" id="invoice-search" placeholder="Search…" />
            </div>
          </div>
        </div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Company</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Subtotal</th>
                <th>Total</th>
                <th>Status</th>
                <th>Date</th>
                <th style="text-align:right">Actions</th>
              </tr>
            </thead>
            <tbody id="invoice-tbody">
              ${renderRows(list)}
            </tbody>
          </table>
        </div>
      </div>
    `;

    bindRowActions();

    document.getElementById('invoice-search').addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      const filtered = invoices.filter(i =>
        i.invoice_no.toLowerCase().includes(q) ||
        i.company_name.toLowerCase().includes(q) ||
        i.customer_name.toLowerCase().includes(q)
      );
      document.getElementById('invoice-tbody').innerHTML = renderRows(filtered);
      bindRowActions();
    });
  }

  function renderRows(list) {
    return list.map(inv => `
      <tr>
        <td><span style="font-family:monospace;font-size:12px;color:var(--text-accent)">${inv.invoice_no}</span></td>
        <td>${inv.company_name}</td>
        <td>${inv.customer_name}</td>
        <td style="color:var(--text-secondary)">${inv.customer_email || '—'}</td>
        <td>$${parseFloat(inv.subtotal).toFixed(2)}</td>
        <td style="font-weight:700">$${parseFloat(inv.total).toFixed(2)}</td>
        <td>
          <span class="badge ${inv.status === 'finalized' ? 'badge-success' : 'badge-warning'}">
            <i class="bi bi-${inv.status === 'finalized' ? 'check-circle' : 'clock'}"></i>
            ${inv.status}
          </span>
        </td>
        <td style="color:var(--text-secondary);font-size:12px">${new Date(inv.created_at).toLocaleDateString()}</td>
        <td>
          <div class="td-actions">
            <button class="btn btn-secondary btn-sm" data-view="${inv.id}" title="View invoice">
              <i class="bi bi-eye"></i>
            </button>
            ${inv.status === 'draft' ? `
              <button class="btn btn-success btn-sm" data-finalize="${inv.id}" data-no="${inv.invoice_no}" title="Finalize & deduct stock">
                <i class="bi bi-check2-all"></i> Finalize
              </button>
              <button class="btn btn-danger btn-sm" data-delete="${inv.id}" data-no="${inv.invoice_no}" title="Delete draft">
                <i class="bi bi-trash3"></i>
              </button>
            ` : `
              <a href="${api.pdfUrl(inv.id)}" target="_blank" class="btn btn-secondary btn-sm" title="Download PDF">
                <i class="bi bi-file-earmark-pdf"></i> PDF
              </a>
            `}
          </div>
        </td>
      </tr>
    `).join('');
  }

  function bindRowActions() {
    app.querySelectorAll('[data-view]').forEach(btn => {
      btn.addEventListener('click', () => viewInvoice(btn.dataset.view));
    });
    app.querySelectorAll('[data-finalize]').forEach(btn => {
      btn.addEventListener('click', () => finalizeInvoice(btn.dataset.finalize, btn.dataset.no));
    });
    app.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteInvoice(btn.dataset.delete, btn.dataset.no));
    });
  }

  // ── View Invoice Detail ───────────────────────────────────
  async function viewInvoice(id) {
    const inv = await api.getInvoice(id).catch(e => { toast.error(e.message); return null; });
    if (!inv) return;

    const tax = inv.total - inv.subtotal;
    openModal({
      title: `Invoice ${inv.invoice_no}`,
      size: 'modal-lg',
      body: `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">FROM</div>
            <div style="font-weight:700">${inv.company_name}</div>
            <div style="color:var(--text-secondary);font-size:12px">${inv.company_email || ''}</div>
            <div style="color:var(--text-secondary);font-size:12px">${inv.company_phone || ''}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">BILL TO</div>
            <div style="font-weight:700">${inv.customer_name}</div>
            <div style="color:var(--text-secondary);font-size:12px">${inv.customer_email || ''}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">DATE</div>
            <div style="font-weight:600">${new Date(inv.created_at).toLocaleDateString()}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">STATUS</div>
            <span class="badge ${inv.status === 'finalized' ? 'badge-success' : 'badge-warning'}">${inv.status}</span>
          </div>
        </div>

        <div class="table-wrapper" style="margin-bottom:16px">
          <table>
            <thead>
              <tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr>
            </thead>
            <tbody>
              ${inv.line_items.map(li => `
                <tr>
                  <td>${li.item_name}</td>
                  <td>${li.quantity}</td>
                  <td>$${parseFloat(li.unit_price).toFixed(2)}</td>
                  <td style="font-weight:600">$${parseFloat(li.line_total).toFixed(2)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <div style="display:flex;gap:24px;color:var(--text-secondary);font-size:13px">
            <span>Subtotal</span><strong style="color:var(--text-primary)">$${parseFloat(inv.subtotal).toFixed(2)}</strong>
          </div>
          ${inv.tax_rate > 0 ? `<div style="display:flex;gap:24px;color:var(--text-secondary);font-size:13px"><span>Tax (${inv.tax_rate}%)</span><strong style="color:var(--text-primary)">$${tax.toFixed(2)}</strong></div>` : ''}
          <div style="display:flex;gap:24px;padding:10px 16px;background:var(--accent-grad);border-radius:8px;font-size:15px;font-weight:800">
            <span>Total</span><span>$${parseFloat(inv.total).toFixed(2)}</span>
          </div>
        </div>

        ${inv.notes ? `<div style="margin-top:16px;padding:12px 14px;background:var(--bg-input);border-radius:8px;font-size:13px;color:var(--text-secondary)"><strong style="color:var(--text-primary)">Notes:</strong> ${inv.notes}</div>` : ''}
      `,
      footer: `
        <button class="btn btn-secondary" id="modal-view-close">Close</button>
        <a href="${api.pdfUrl(inv.id)}" target="_blank" class="btn btn-primary">
          <i class="bi bi-file-earmark-pdf"></i> Download PDF
        </a>
      `,
    });

    document.getElementById('modal-view-close').addEventListener('click', closeModal);
  }

  // ── Finalize Invoice ──────────────────────────────────────
  async function finalizeInvoice(id, no) {
    const ok = await confirm({
      title: 'Finalize Invoice',
      message: `Finalize <strong>${no}</strong>? Stock will be permanently deducted from inventory. This cannot be undone.`,
      confirmText: 'Finalize & Deduct Stock',
    });
    if (!ok) return;
    try {
      await api.finalizeInvoice(id);
      toast.success('Invoice finalized and stock updated!');
      await load();
    } catch (err) {
      toast.error(err.message, 'Finalization Failed');
    }
  }

  // ── Delete Draft ──────────────────────────────────────────
  async function deleteInvoice(id, no) {
    const ok = await confirm({
      title: 'Delete Draft Invoice',
      message: `Delete draft <strong>${no}</strong>? This cannot be undone.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteInvoice(id);
      toast.success('Draft invoice deleted.');
      await load();
    } catch (err) {
      toast.error(err.message);
    }
  }
}

// ── New Invoice Modal ─────────────────────────────────────────
async function openNewInvoiceModal(onCreated) {
  let companies = [];
  let companyItems = [];
  let lineItems = [];

  try { companies = await api.getCompanies(); } catch (e) { toast.error(e.message); return; }

  if (companies.length === 0) {
    toast.warning('Please add a company first before creating an invoice.');
    return;
  }

  const modal = openModal({
    title: 'Create New Invoice',
    size: 'modal-xl',
    body: buildInvoiceForm(companies),
    footer: `
      <button class="btn btn-secondary" id="inv-cancel">Cancel</button>
      <button class="btn btn-primary" id="inv-create">
        <i class="bi bi-file-earmark-plus"></i> Create Draft
      </button>
    `,
  });

  const companySelect = modal.querySelector('#inv-company');
  const itemsSection  = modal.querySelector('#inv-items-section');
  const taxInput      = modal.querySelector('#inv-tax');
  const subtotalEl    = modal.querySelector('#inv-subtotal');
  const taxEl         = modal.querySelector('#inv-tax-amount');
  const totalEl       = modal.querySelector('#inv-total');
  const errEl         = modal.querySelector('#inv-error');
  const errMsg        = modal.querySelector('#inv-error-msg');

  // ── Company changed → load items ─────────────────────────
  companySelect.addEventListener('change', async () => {
    const cid = companySelect.value;
    if (!cid) { itemsSection.classList.add('hidden'); lineItems = []; return; }

    itemsSection.classList.remove('hidden');
    companyItems = await api.getItems(cid).catch(() => []);
    lineItems = [];
    renderLineItems();
  });

  // ── Tax input → recalculate ───────────────────────────────
  taxInput.addEventListener('input', calcTotals);

  // ── Add line item ─────────────────────────────────────────
  modal.querySelector('#add-line-btn').addEventListener('click', () => {
    lineItems.push({ item_id: '', item_name: '', quantity: 1, unit_price: 0 });
    renderLineItems();
  });

  function renderLineItems() {
    const tbody = modal.querySelector('#line-items-tbody');
    tbody.innerHTML = lineItems.length === 0
      ? `<tr><td colspan="5" class="empty-state" style="padding:20px;text-align:center;color:var(--text-muted)">
          <i class="bi bi-plus-circle" style="font-size:24px;display:block;margin-bottom:8px"></i>Click "Add Item" to add line items
         </td></tr>`
      : lineItems.map((li, idx) => `
          <tr>
            <td style="min-width:200px">
              <select class="li-item" data-idx="${idx}">
                <option value="">Select item…</option>
                ${companyItems.map(item => `
                  <option value="${item.id}" data-price="${item.unit_price}" data-name="${item.name}"
                    ${li.item_id == item.id ? 'selected' : ''}>
                    ${item.name} (${item.quantity} ${item.unit})
                  </option>
                `).join('')}
              </select>
            </td>
            <td style="width:90px">
              <input type="number" class="li-qty" data-idx="${idx}" min="0.01" step="0.01"
                value="${li.quantity}" placeholder="Qty" />
            </td>
            <td style="width:110px">
              <input type="number" class="li-price" data-idx="${idx}" min="0" step="0.01"
                value="${li.unit_price || ''}" placeholder="Price" />
            </td>
            <td style="width:100px;font-weight:600;text-align:right">
              $${(li.quantity * li.unit_price).toFixed(2)}
            </td>
            <td style="width:40px">
              <button class="btn btn-danger btn-icon btn-sm li-remove" data-idx="${idx}">
                <i class="bi bi-x-lg"></i>
              </button>
            </td>
          </tr>
        `).join('');

    // Bind select changes
    tbody.querySelectorAll('.li-item').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.idx);
        const opt = sel.selectedOptions[0];
        lineItems[idx].item_id   = sel.value;
        lineItems[idx].item_name = opt.dataset.name || '';
        lineItems[idx].unit_price = parseFloat(opt.dataset.price || 0);
        renderLineItems();
        calcTotals();
      });
    });

    // Bind quantity changes
    tbody.querySelectorAll('.li-qty').forEach(input => {
      input.addEventListener('input', () => {
        lineItems[parseInt(input.dataset.idx)].quantity = parseFloat(input.value) || 0;
        calcTotals();
        // Update line total display without full re-render
        const row = input.closest('tr');
        const li = lineItems[parseInt(input.dataset.idx)];
        row.cells[3].textContent = `$${(li.quantity * li.unit_price).toFixed(2)}`;
      });
    });

    // Bind price changes
    tbody.querySelectorAll('.li-price').forEach(input => {
      input.addEventListener('input', () => {
        lineItems[parseInt(input.dataset.idx)].unit_price = parseFloat(input.value) || 0;
        calcTotals();
        const row = input.closest('tr');
        const li = lineItems[parseInt(input.dataset.idx)];
        row.cells[3].textContent = `$${(li.quantity * li.unit_price).toFixed(2)}`;
      });
    });

    // Bind remove buttons
    tbody.querySelectorAll('.li-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        lineItems.splice(parseInt(btn.dataset.idx), 1);
        renderLineItems();
        calcTotals();
      });
    });

    calcTotals();
  }

  function calcTotals() {
    const subtotal = lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0);
    const taxRate  = parseFloat(taxInput.value) || 0;
    const tax      = subtotal * (taxRate / 100);
    const total    = subtotal + tax;
    subtotalEl.textContent = `$${subtotal.toFixed(2)}`;
    taxEl.textContent      = `$${tax.toFixed(2)}`;
    totalEl.textContent    = `$${total.toFixed(2)}`;
  }

  modal.querySelector('#inv-cancel').addEventListener('click', closeModal);

  modal.querySelector('#inv-create').addEventListener('click', async () => {
    const company_id    = companySelect.value;
    const customer_name = modal.querySelector('#inv-customer').value.trim();
    const customer_email= modal.querySelector('#inv-email').value.trim();
    const notes         = modal.querySelector('#inv-notes').value.trim();
    const tax_rate      = parseFloat(taxInput.value) || 0;

    errEl.classList.add('hidden');

    if (!company_id) { errMsg.textContent = 'Please select a company.'; errEl.classList.remove('hidden'); return; }
    if (!customer_name) { errMsg.textContent = 'Customer name is required.'; errEl.classList.remove('hidden'); return; }
    if (lineItems.length === 0) { errMsg.textContent = 'Add at least one line item.'; errEl.classList.remove('hidden'); return; }
    if (lineItems.some(li => !li.item_id)) { errMsg.textContent = 'All line items must have an item selected.'; errEl.classList.remove('hidden'); return; }
    if (lineItems.some(li => li.quantity <= 0)) { errMsg.textContent = 'All quantities must be greater than 0.'; errEl.classList.remove('hidden'); return; }

    const saveBtn = modal.querySelector('#inv-create');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Creating…';

    try {
      await api.createInvoice({ company_id, customer_name, customer_email, notes, tax_rate, line_items: lineItems });
      toast.success('Invoice created as draft. Finalize it to deduct stock.');
      closeModal();
      onCreated();
    } catch (err) {
      errMsg.textContent = err.message;
      errEl.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="bi bi-file-earmark-plus"></i> Create Draft';
    }
  });
}

function buildInvoiceForm(companies) {
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      <div class="form-group" style="margin:0">
        <label for="inv-company">Company / Vendor <span style="color:var(--danger)">*</span></label>
        <select id="inv-company">
          <option value="">Select company…</option>
          ${companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin:0">
        <label for="inv-customer">Customer Name <span style="color:var(--danger)">*</span></label>
        <input id="inv-customer" type="text" placeholder="e.g. John Doe / Acme Ltd" />
      </div>
      <div class="form-group" style="margin:0">
        <label for="inv-email">Customer Email</label>
        <input id="inv-email" type="email" placeholder="customer@email.com" />
      </div>
      <div class="form-group" style="margin:0">
        <label for="inv-tax">Tax Rate (%)</label>
        <input id="inv-tax" type="number" min="0" max="100" step="0.5" placeholder="0" value="0" />
      </div>
    </div>

    <div class="form-group">
      <label for="inv-notes">Notes (optional)</label>
      <textarea id="inv-notes" rows="2" placeholder="Payment terms, special instructions…"></textarea>
    </div>

    <hr class="divider" />

    <!-- Line Items -->
    <div id="inv-items-section" class="hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <label style="margin:0;font-size:13px;font-weight:700;color:var(--text-primary)">Line Items</label>
        <button type="button" class="btn btn-secondary btn-sm" id="add-line-btn">
          <i class="bi bi-plus-lg"></i> Add Item
        </button>
      </div>

      <div class="table-wrapper" style="margin-bottom:12px">
        <table class="line-items-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Unit Price</th>
              <th style="text-align:right">Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="line-items-tbody"></tbody>
        </table>
      </div>

      <!-- Totals -->
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <div style="display:flex;gap:24px;font-size:13px;color:var(--text-secondary)">
          <span>Subtotal</span><strong id="inv-subtotal" style="color:var(--text-primary)">$0.00</strong>
        </div>
        <div style="display:flex;gap:24px;font-size:13px;color:var(--text-secondary)">
          <span>Tax</span><strong id="inv-tax-amount" style="color:var(--text-primary)">$0.00</strong>
        </div>
        <div style="display:flex;gap:24px;padding:10px 16px;background:var(--accent-grad);border-radius:8px;font-size:15px;font-weight:800">
          <span>Total</span><span id="inv-total">$0.00</span>
        </div>
      </div>
    </div>

    <div id="inv-items-placeholder" style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px">
      <i class="bi bi-arrow-up-circle" style="font-size:24px;display:block;margin-bottom:8px;opacity:0.4"></i>
      Select a company above to load available items
    </div>

    <div id="inv-error" class="login-error hidden" style="margin-top:12px">
      <i class="bi bi-exclamation-circle"></i><span id="inv-error-msg"></span>
    </div>
  `;
}
