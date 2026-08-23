/** Dashboard page — clean, minimalist, professional redesign */

import { api } from '../api.js';

export async function renderDashboard() {
  const app = document.getElementById('app');

  // ── Topbar ──────────────────────────────────────────────────
  document.getElementById('topbar').innerHTML = `
    <div>
      <span class="topbar-title">Dashboard</span>
      <span style="font-size:12px;color:var(--text-muted);margin-left:10px">
        ${new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}
      </span>
    </div>
  `;

  app.innerHTML = `<div class="loading-page"><div class="spinner"></div><span>Loading…</span></div>`;

  try {
    const [companies, invoiceStats, invoices] = await Promise.all([
      api.getCompanies(),
      api.getInvoiceStats(),
      api.getInvoices(),
    ]);

    const totalLowStock = companies.reduce((s, c) => s + (c.low_stock_count || 0), 0);
    const totalItems    = companies.reduce((s, c) => s + (c.item_count || 0), 0);
    const recent        = invoices.slice(0, 8);

    app.innerHTML = `
      <div class="page-enter db-wrap">

        ${totalLowStock > 0 ? `
        <!-- Alert Banner -->
        <div class="db-alert">
          <i class="bi bi-exclamation-triangle"></i>
          <span><strong>${totalLowStock} item${totalLowStock > 1 ? 's' : ''}</strong> running low on stock — review your inventory.</span>
        </div>` : ''}

        <!-- KPI Row -->
        <div class="db-kpi-row">
          ${kpiCard('Companies',    companies.length,      'bi-building',        'kpi-indigo')}
          ${kpiCard('Stock Items',  totalItems,            'bi-box-seam',        'kpi-slate')}
          ${kpiCard('Low Stock',    totalLowStock,         'bi-exclamation-circle', totalLowStock > 0 ? 'kpi-amber' : 'kpi-slate')}
          ${kpiCard('Invoices',     invoiceStats.totalInvoices, 'bi-receipt',    'kpi-slate')}
          ${kpiCard('Revenue',      '$' + fmtMoney(invoiceStats.totalRevenue), 'bi-currency-dollar', 'kpi-green')}
        </div>

        <!-- Content Grid -->
        <div class="db-content-grid">

          <!-- Recent Invoices -->
          <div class="db-card">
            <div class="db-card-head">
              <div class="db-card-title">Recent Invoices</div>
              <span class="db-chip">${invoiceStats.totalInvoices} total</span>
            </div>

            ${recent.length === 0 ? `
              <div class="db-empty">
                <i class="bi bi-receipt" style="font-size:32px;opacity:.2;margin-bottom:10px"></i>
                <p>No invoices yet</p>
              </div>
            ` : `
              <div class="db-table-wrap">
                <table class="db-table">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Company</th>
                      <th>Customer</th>
                      <th style="text-align:right">Amount</th>
                      <th>Status</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${recent.map(inv => `
                      <tr>
                        <td class="db-mono">${inv.invoice_no}</td>
                        <td class="db-company-cell">${inv.company_name}</td>
                        <td class="db-secondary">${inv.customer_name}</td>
                        <td style="text-align:right;font-weight:600;letter-spacing:-.3px">
                          $${parseFloat(inv.total).toFixed(2)}
                        </td>
                        <td>
                          <span class="db-status db-status-${inv.status}">
                            ${inv.status === 'finalized' ? '<i class="bi bi-check-circle"></i>' : '<i class="bi bi-clock"></i>'}
                            ${inv.status}
                          </span>
                        </td>
                        <td class="db-secondary db-date">
                          ${new Date(inv.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric' })}
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>

          <!-- Right column -->
          <div class="db-side">

            <!-- Companies health -->
            <div class="db-card">
              <div class="db-card-head">
                <div class="db-card-title">Stock Health</div>
              </div>
              <div class="db-company-list">
                ${companies.length === 0 ? `
                  <div class="db-empty"><p>No companies yet</p></div>
                ` : companies.map(c => {
                  const low = c.low_stock_count || 0;
                  const total = c.item_count || 0;
                  const pct = total > 0 ? Math.max(5, Math.round(((total - low) / total) * 100)) : 100;
                  const color = low === 0 ? 'var(--success)' : low >= total / 2 ? 'var(--danger)' : 'var(--warning)';
                  return `
                    <div class="db-co-row">
                      <div class="db-co-icon">
                        <i class="bi bi-building"></i>
                      </div>
                      <div class="db-co-info">
                        <div class="db-co-name">${c.name}</div>
                        <div class="db-co-bar">
                          <div class="db-co-bar-fill" style="width:${pct}%;background:${color}"></div>
                        </div>
                      </div>
                      <div class="db-co-stat" style="color:${low > 0 ? 'var(--warning)' : 'var(--text-muted)'}">
                        ${low > 0 ? `${low} low` : `${total} ok`}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

            <!-- Quick actions -->
            <div class="db-card db-actions-card">
              <div class="db-card-title" style="margin-bottom:14px">Quick Actions</div>
              <div class="db-action-list">
                <button class="db-action-btn" data-nav="invoices">
                  <i class="bi bi-plus-circle"></i>
                  <span>New Invoice</span>
                  <i class="bi bi-chevron-right db-action-arrow"></i>
                </button>
                <button class="db-action-btn" data-nav="stock">
                  <i class="bi bi-box-seam"></i>
                  <span>Manage Stock</span>
                  <i class="bi bi-chevron-right db-action-arrow"></i>
                </button>
                <button class="db-action-btn" data-nav="companies">
                  <i class="bi bi-building-add"></i>
                  <span>Add Company</span>
                  <i class="bi bi-chevron-right db-action-arrow"></i>
                </button>
              </div>
            </div>

          </div><!-- /db-side -->
        </div><!-- /db-content-grid -->
      </div>
    `;

    // Quick action navigation
    app.querySelectorAll('[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => {
        window.location.hash = btn.dataset.nav;
      });
    });

  } catch (err) {
    app.innerHTML = `
      <div class="db-empty" style="height:300px">
        <i class="bi bi-exclamation-circle" style="font-size:32px;opacity:.3;margin-bottom:10px"></i>
        <p>${err.message}</p>
      </div>`;
  }
}

// ── Helper: KPI card ─────────────────────────────────────────
function kpiCard(label, value, icon, colorClass) {
  return `
    <div class="db-kpi ${colorClass}">
      <div class="db-kpi-body">
        <div class="db-kpi-label">${label}</div>
        <div class="db-kpi-value">${value}</div>
      </div>
      <div class="db-kpi-icon"><i class="bi ${icon}"></i></div>
    </div>
  `;
}

// ── Helper: format money ─────────────────────────────────────
function fmtMoney(n) {
  const num = Number(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000)     return (num / 1_000).toFixed(1) + 'k';
  return num.toFixed(0);
}
