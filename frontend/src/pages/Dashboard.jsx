import { useEffect, useState, useCallback } from 'react';
import { motion, animate, useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem } from '../lib/motion.js';
import { formatCurrency, formatDate } from '../lib/format.js';
import { IconCompany, IconStock, IconInvoice, IconAlert, IconWarning, IconSuccess, IconPending,
         IconPlusCircle, IconChevron, IconRefresh, ICON_MD, ICON_LG } from '../lib/icons.jsx';

function KpiCard({ label, value, Icon, accent }) {
  return (
    <motion.div className="db-kpi" style={{ '--kpi-accent': accent }} variants={listItem}>
      <div className="db-kpi-body">
        <div className="db-kpi-label">{label}</div>
        {/* Counts up from 0 so the figure registers as data arriving. */}
        <div className="db-kpi-value"><CountUp value={value} /></div>
      </div>
      <Icon size={ICON_LG} className="db-kpi-icon" />
    </motion.div>
  );
}

/**
 * Animates an integer from 0 to `value`.
 * Skipped entirely when the user prefers reduced motion, and for values large
 * enough that ticking through them would read as noise rather than polish.
 */
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
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="loading-page">
      <div className="spinner" /><span>Loading…</span>
    </div>
  );

  // A dead end before: the message with no way to act on it, on a page whose
  // only recovery was reloading the browser.
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

  const { companies, stats, recent } = data;
  const totalLowStock = companies.reduce((s, c) => s + (c.low_stock_count || 0), 0);
  const totalItems    = companies.reduce((s, c) => s + (c.item_count    || 0), 0);

  return (
    <div className="db-wrap page-enter">

      {/* Figures go stale the moment an invoice is finalized in another tab,
          and there was no way to ask for fresh ones short of a full reload. */}
      <div className="db-toolbar">
        <button type="button" className="btn btn-secondary btn-sm"
                onClick={() => load({ quiet: true })} disabled={refreshing}>
          {refreshing
            ? <><span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} /> Refreshing…</>
            : <><IconRefresh size={ICON_MD} /> Refresh</>}
        </button>
      </div>

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
        <KpiCard label="Companies"   value={companies.length}  Icon={IconCompany} accent="var(--accent)" />
        <KpiCard label="Stock Items" value={totalItems}        Icon={IconStock} accent="var(--info)" />
        <KpiCard label="Low Stock"   value={totalLowStock}     Icon={IconAlert} accent={totalLowStock > 0 ? 'var(--warning)' : 'var(--success)'} />
        <KpiCard label="Invoices"    value={stats.totalInvoices} Icon={IconInvoice} accent="var(--success)" />
      </motion.div>

      {/* Main grid */}
      <div className="db-content-grid">

        {/* Recent invoices */}
        <div className="db-card">
          <div className="db-card-head">
            <span className="db-card-title">Recent Invoices</span>
            <div className="db-card-head-actions">
              <span className="db-chip">{stats.totalInvoices} total</span>
              {recent.length > 0 && (
                <button type="button" className="db-link-btn" onClick={() => navigate('/invoices')}>
                  View all <IconChevron size={12} />
                </button>
              )}
            </div>
          </div>

          {recent.length === 0 ? (
            <div className="db-empty">
              <IconInvoice />
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
                    <th className="num">Amount</th>
                    <th>Status</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <motion.tbody variants={listContainer} initial="initial" animate="animate">
                  {/* Rows open the invoice rather than merely listing it —
                      previously the whole panel was a dead end. */}
                  {recent.map(inv => (
                    <motion.tr
                      key={inv.id}
                      variants={listItem}
                      className="db-row-link"
                      role="button"
                      tabIndex={0}
                      title={`Open ${inv.invoice_no}`}
                      onClick={() => navigate(`/invoices?view=${inv.id}`)}
                      onKeyDown={e => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        navigate(`/invoices?view=${inv.id}`);
                      }}
                    >
                      <td className="db-mono">{inv.invoice_no}</td>
                      <td className="db-company-cell">{inv.company_name}</td>
                      <td className="db-secondary">{inv.customer_name}</td>
                      <td className="num num-strong">
                        {formatCurrency(inv.total)}
                      </td>
                      <td>
                        <span className={`db-status db-status-${inv.status}`}>
                          {inv.status}
                        </span>
                      </td>
                      <td className="db-secondary db-date">
                        {formatDate(inv.created_at, { short: true })}
                      </td>
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

          {/* Quick actions */}
          <div className="db-card db-actions-card">
            <div className="db-card-title" style={{ marginBottom: 14 }}>Quick Actions</div>
            <div className="db-action-list">
              {[
                { label: 'New Invoice',  Icon: IconPlusCircle, to: '/invoices' },
                { label: 'Manage Stock', Icon: IconStock,      to: '/stock'    },
                { label: 'Add Company',  Icon: IconCompany,    to: '/companies' },
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
