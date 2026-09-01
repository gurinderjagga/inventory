import { useEffect, useState, useCallback } from 'react';
import { motion, animate, useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { api, isAuthError } from '../api.js';
import { cached, CACHE_COMPANIES } from '../lib/cache.js';
import { listContainer, listItem } from '../lib/motion.js';
import { formatDate, formatCurrencyShort } from '../lib/format.js';
import {
  IconCompany, IconStock, IconStockIn, IconStockOut, IconTransactions, IconInvoice,
  IconAlert, IconWarning,
  IconPlusCircle, IconChevron, IconRefresh, ICON_MD, ICON_LG,
} from '../lib/icons.jsx';

// ── Skeleton ──────────────────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <div className="db-wrap page-enter">
      {/* KPI strip */}
      <div className="db-kpi-row">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="skeleton-kpi">
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
          </div>
        ))}
      </div>

      {/* Content grid */}
      <div className="db-content-grid">
        <div className="db-card">
          <div className="skeleton-table">
            <div className="skeleton-thead">
              {[1, 2, 3, 4].map(i => <div key={i} className="skeleton-bar" />)}
            </div>
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="skeleton-row" style={{ opacity: 1 - i * 0.12 }}>
                <div className="skeleton-bar" />
                <div className="skeleton-bar" />
                <div className="skeleton-bar" />
                <div className="skeleton-bar" />
              </div>
            ))}
          </div>
        </div>
        <div className="db-side">
          <div className="db-card">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4 }}>
              {[1, 2, 3].map(i => (
                <div key={i} className="skeleton-bar" style={{ height: 32, borderRadius: 4 }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────────────

function KpiCard({ label, value, Icon, accent }) {
  return (
    <motion.div className="db-kpi" style={{ '--kpi-accent': accent }} variants={listItem}>
      <div className="db-kpi-body">
        <div className="db-kpi-label">{label}</div>
        <div className="db-kpi-value"><CountUp value={value} /></div>
      </div>
      <Icon size={ICON_LG} className="db-kpi-icon" />
    </motion.div>
  );
}

function CountUp({ value }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);

  useEffect(() => {
    if (reduce || value > 9999) { setShown(value); return; }
    const controls = animate(0, value, {
      duration: 0.7,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setShown(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, reduce]);

  return <>{shown}</>;
}

function reasonLabel(reason) {
  const map = {
    stock_in:          'Stock In',
    stock_out:         'Stock Out',
    initial_stock:     'Opening',
    manual_adjustment: 'Adjustment',
    invoice_finalize:  'Invoice',
    invoice_reversal:  'Reversal',
  };
  return map[reason] || reason;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (quiet) setRefreshing(true);
    setError('');
    try {
      // Fetch companies (cached) and a preliminary movements list in parallel.
      // The movements need a company ID, so we pick the best candidate from the
      // cached company list first, then fire both requests at once.
      const companies = await cached(CACHE_COMPANIES, () => api.getCompanies());
      const firstCo   = companies.find(c => c.item_count > 0 && c.active !== false) || companies[0];

      // Kick off movements fetch in parallel with nothing else blocking us.
      const movResult = firstCo
        ? await api.getStockMovements(firstCo.id, null, 10)
        : { movements: [] };

      // Invoicing is opt-in per company (see the Companies "Features" toggle) —
      // only fetch and show its stats when this company actually has it on,
      // rather than a permanently-empty card for everyone else.
      let invoiceStats = null;
      if (firstCo) {
        try {
          const features = await api.getCompanyFeatures(firstCo.id);
          if (features.includes('invoicing')) {
            invoiceStats = await api.getInvoiceStats(firstCo.id);
          }
        } catch { /* not fatal to the rest of the dashboard */ }
      }

      setData({ companies, recent: movResult.movements || [], firstCo, invoiceStats });
    } catch (err) {
      if (!isAuthError(err)) setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <DashboardSkeleton />;

  if (error) return (
    <div className="db-empty" style={{ height: 300 }}>
      <IconAlert />
      <p>{error}</p>
      <button type="button" className="btn btn-secondary" style={{ marginTop: 12 }}
              onClick={() => { setLoading(true); load(); }}>
        <IconRefresh size={ICON_MD} /> Try again
      </button>
    </div>
  );

  const { companies, recent, firstCo, invoiceStats } = data;
  const totalLowStock = companies.reduce((s, c) => s + (c.low_stock_count || 0), 0);
  const totalItems    = companies.reduce((s, c) => s + (c.item_count    || 0), 0);

  // Count today's stock in/out from recent movements
  const today = new Date().toDateString();
  const todayIn  = recent.filter(m => new Date(m.created_at).toDateString() === today && Number(m.quantity_delta) > 0).length;
  const todayOut = recent.filter(m => new Date(m.created_at).toDateString() === today && Number(m.quantity_delta) < 0).length;

  return (
    <div className="db-wrap page-enter">

      {/* Low-stock alert */}
      {totalLowStock > 0 && (
        <div className="db-alert">
          <IconWarning size={ICON_MD} />
          <span>
            <strong>{totalLowStock} item{totalLowStock > 1 ? 's' : ''}</strong> running low on stock —&nbsp;
            <button className="db-alert-link" onClick={() => navigate('/stock')}>
              review inventory
            </button>
          </span>
        </div>
      )}

      {/* KPI strip */}
      <motion.div className="db-kpi-row" variants={listContainer} initial="initial" animate="animate">
        <KpiCard label="Companies"      value={companies.length} Icon={IconCompany}    accent="var(--accent)" />
        <KpiCard label="Low Stock"      value={totalLowStock}    Icon={IconAlert}      accent={totalLowStock > 0 ? 'var(--warning)' : 'var(--success)'} />
        <KpiCard label="Stock In Today"  value={todayIn}         Icon={IconStockIn}    accent="var(--success)" />
        <KpiCard label="Stock Out Today" value={todayOut}        Icon={IconStockOut}   accent="var(--danger)" />
      </motion.div>

      {/* Main grid */}
      <div className="db-content-grid">

        {/* Recent movements */}
        <div className="db-card">
          <div className="db-card-head">
            <span className="db-card-title">
              Recent Movements{firstCo ? ` — ${firstCo.name}` : ''}
            </span>
            <div className="db-card-head-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => load({ quiet: true })}
                disabled={refreshing}
                title="Refresh"
                aria-label="Refresh movements"
              >
                <IconRefresh size={ICON_MD} style={refreshing ? { animation: 'spin 0.8s linear infinite' } : undefined} />
              </button>
              {recent.length > 0 && (
                <button type="button" className="db-link-btn" onClick={() => navigate('/transactions?tab=history')}>
                  View all <IconChevron size={12} />
                </button>
              )}
            </div>
          </div>

          {recent.length === 0 ? (
            <div className="db-empty">
              <IconTransactions size={ICON_LG} />
              <p>No stock movements yet — use Stock In / Stock Out to record activity.</p>
            </div>
          ) : (
            <div className="db-table-wrap">
              <table className="db-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Item</th>
                    <th>Type</th>
                    <th className="num">Qty</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <motion.tbody variants={listContainer} initial="initial" animate="animate">
                  {recent.map(m => (
                    <motion.tr key={m.id} variants={listItem}>
                      <td className="db-secondary db-date">{formatDate(m.created_at, { short: true })}</td>
                      <td><strong>{m.item_name}</strong></td>
                      <td>
                        <span className={`txn-badge ${Number(m.quantity_delta) >= 0 ? 'txn-in' : 'txn-out'}`}>
                          {reasonLabel(m.reason)}
                        </span>
                      </td>
                      <td className="num num-strong"
                          style={{ color: Number(m.quantity_delta) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                        {Number(m.quantity_delta) >= 0 ? '+' : ''}{Number(m.quantity_delta)}
                      </td>
                      <td className="db-secondary">{m.note || '—'}</td>
                    </motion.tr>
                  ))}
                </motion.tbody>
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
                    <div className="db-co-icon"><IconCompany size={ICON_MD} /></div>
                    <div className="db-co-info">
                      <div className="db-co-name">{c.name}</div>
                      <div className="db-co-bar">
                        <motion.div
                          className="db-co-bar-fill"
                          style={{ background: color }}
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
                        />
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

          {/* Invoicing — only shown once the company has the feature turned on */}
          {invoiceStats && (
            <div className="db-card">
              <div className="db-card-head">
                <span className="db-card-title">Invoicing — {firstCo.name}</span>
                <button type="button" className="db-link-btn" onClick={() => navigate(`/invoices?company=${firstCo.id}`)}>
                  View all <IconChevron size={12} />
                </button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 4px 8px' }}>
                <div>
                  <div className="db-secondary" style={{ fontSize: 11 }}>Finalized Revenue</div>
                  <div style={{ fontSize: 20, fontWeight: 600 }}>{formatCurrencyShort(invoiceStats.finalized_revenue)}</div>
                </div>
                <div>
                  <div className="db-secondary" style={{ fontSize: 11 }}>Drafts</div>
                  <div style={{ fontSize: 20, fontWeight: 600 }}>{invoiceStats.draft_count}</div>
                </div>
                <div>
                  <div className="db-secondary" style={{ fontSize: 11 }}>Total</div>
                  <div style={{ fontSize: 20, fontWeight: 600 }}>{invoiceStats.total_invoices}</div>
                </div>
              </div>
            </div>
          )}

          {/* Quick actions */}
          <div className="db-card db-actions-card">
            <div className="db-card-title" style={{ marginBottom: 14 }}>Quick Actions</div>
            <div className="db-action-list">
              {[
                { label: 'Stock In',       Icon: IconStockIn,      to: '/transactions' },
                { label: 'Stock Out',      Icon: IconStockOut,     to: '/transactions' },
                { label: 'Manage Stock',   Icon: IconStock,        to: '/stock'        },
                { label: 'New Invoice',    Icon: IconInvoice,      to: '/invoices'     },
                { label: 'Add Company',    Icon: IconCompany,      to: '/companies'    },
                { label: 'View History',   Icon: IconTransactions, to: '/transactions' },
              ].map(a => (
                <button key={a.label} className="db-action-btn" onClick={() => navigate(a.to)}>
                  <a.Icon size={ICON_MD} />
                  <span>{a.label}</span>
                  <IconChevron size={ICON_MD} className="db-action-arrow" />
                </button>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
