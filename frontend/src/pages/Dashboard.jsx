import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, isAuthError } from '../api.js';
import { useAuth } from '../contexts/AuthContext.jsx';

function KpiCard({ label, value, icon, accent }) {
  return (
    <div className="db-kpi" style={{ '--kpi-accent': accent }}>
      <div className="db-kpi-body">
        <div className="db-kpi-label">{label}</div>
        <div className="db-kpi-value">{value}</div>
      </div>
      <i className={`bi ${icon} db-kpi-icon`} />
    </div>
  );
}

export default function Dashboard() {
  const navigate  = useNavigate();
  const { isAdmin } = useAuth();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [companies, stats, invoices] = await Promise.all([
          api.getCompanies(),
          api.getInvoiceStats(),
          api.getInvoices(),
        ]);
        setData({ companies, stats, recent: invoices.slice(0, 8) });
      } catch (err) {
        // Session expiry redirects to /login on its own; no error screen needed.
        if (!isAuthError(err)) setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return (
    <div className="loading-page">
      <div className="spinner" /><span>Loading…</span>
    </div>
  );

  if (error) return (
    <div className="db-empty" style={{ height: 300 }}>
      <i className="bi bi-exclamation-circle" style={{ fontSize: 36, opacity: .25, marginBottom: 12 }} />
      <p>{error}</p>
    </div>
  );

  const { companies, stats, recent } = data;
  const totalLowStock = companies.reduce((s, c) => s + (c.low_stock_count || 0), 0);
  const totalItems    = companies.reduce((s, c) => s + (c.item_count    || 0), 0);

  return (
    <div className="db-wrap page-enter">

      {/* Low-stock alert */}
      {totalLowStock > 0 && (
        <div className="db-alert">
          <i className="bi bi-exclamation-triangle" />
          <span>
            <strong>{totalLowStock} item{totalLowStock > 1 ? 's' : ''}</strong> running low on stock —&nbsp;
            <button className="db-alert-link" onClick={() => navigate('/stock')}>
              review inventory
            </button>
          </span>
        </div>
      )}

      {/* KPI strip */}
      <div className="db-kpi-row">
        <KpiCard label="Companies"   value={companies.length}  icon="bi-building"           accent="var(--accent)" />
        <KpiCard label="Stock Items" value={totalItems}        icon="bi-box-seam"           accent="rgba(255,255,255,0.1)" />
        <KpiCard label="Low Stock"   value={totalLowStock}     icon="bi-exclamation-circle" accent={totalLowStock > 0 ? 'var(--warning)' : 'rgba(255,255,255,0.1)'} />
        <KpiCard label="Invoices"    value={stats.totalInvoices} icon="bi-receipt"          accent="rgba(255,255,255,0.1)" />
      </div>

      {/* Main grid */}
      <div className="db-content-grid">

        {/* Recent invoices */}
        <div className="db-card">
          <div className="db-card-head">
            <span className="db-card-title">Recent Invoices</span>
            <span className="db-chip">{stats.totalInvoices} total</span>
          </div>

          {recent.length === 0 ? (
            <div className="db-empty">
              <i className="bi bi-receipt" style={{ fontSize: 32, opacity: .2, marginBottom: 10 }} />
              <p>No invoices yet — create one from the Invoices page.</p>
            </div>
          ) : (
            <div className="db-table-wrap">
              <table className="db-table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Company</th>
                    <th>Customer</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th>Status</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(inv => (
                    <tr key={inv.id}>
                      <td className="db-mono">{inv.invoice_no}</td>
                      <td className="db-company-cell">{inv.company_name}</td>
                      <td className="db-secondary">{inv.customer_name}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, letterSpacing: '-.3px' }}>
                        ${parseFloat(inv.total).toFixed(2)}
                      </td>
                      <td>
                        <span className={`db-status db-status-${inv.status}`}>
                          <i className={`bi bi-${inv.status === 'finalized' ? 'check-circle' : 'clock'}`} />
                          {inv.status}
                        </span>
                      </td>
                      <td className="db-secondary db-date">
                        {new Date(inv.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="db-side">

          {/* Stock health */}
          <div className="db-card">
            <div className="db-card-head">
              <span className="db-card-title">Stock Health</span>
            </div>
            <div className="db-company-list">
              {companies.length === 0 ? (
                <div className="db-empty"><p>No companies yet</p></div>
              ) : companies.map(c => {
                const low   = c.low_stock_count || 0;
                const total = c.item_count || 0;
                const pct   = total > 0 ? Math.max(4, Math.round(((total - low) / total) * 100)) : 100;
                const color = low === 0 ? 'var(--success)' : low >= total / 2 ? 'var(--danger)' : 'var(--warning)';
                return (
                  <div className="db-co-row" key={c.id}>
                    <div className="db-co-icon"><i className="bi bi-building" /></div>
                    <div className="db-co-info">
                      <div className="db-co-name">{c.name}</div>
                      <div className="db-co-bar">
                        <div className="db-co-bar-fill" style={{ width: `${pct}%`, background: color }} />
                      </div>
                    </div>
                    <div className="db-co-stat" style={{ color: low > 0 ? 'var(--warning)' : 'var(--text-muted)' }}>
                      {low > 0 ? `${low} low` : `${total} ok`}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quick actions */}
          <div className="db-card db-actions-card">
            <div className="db-card-title" style={{ marginBottom: 14 }}>Quick Actions</div>
            <div className="db-action-list">
              {[
                { label: 'New Invoice',    icon: 'bi-plus-circle',    to: '/invoices' },
                { label: 'Manage Stock',   icon: 'bi-box-seam',       to: '/stock'    },
                // Only a platform admin can add a company; for anyone else this
                // linked to a page whose action the API refuses.
                isAdmin
                  ? { label: 'Add Company',  icon: 'bi-building-add', to: '/companies' }
                  : { label: 'My Company',   icon: 'bi-building',     to: '/companies' },
              ].map(a => (
                <button key={a.label} className="db-action-btn" onClick={() => navigate(a.to)}>
                  <i className={`bi ${a.icon}`} />
                  <span>{a.label}</span>
                  <i className="bi bi-chevron-right db-action-arrow" />
                </button>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
