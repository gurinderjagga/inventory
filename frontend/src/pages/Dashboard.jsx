import { useEffect, useState, useCallback } from 'react';
import { motion, animate, useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { api, isAuthError } from '../api.js';
import { listContainer, listItem } from '../lib/motion.js';
import { formatDate } from '../lib/format.js';
import {
  IconCompany, IconStock, IconStockIn, IconStockOut, IconTransactions,
  IconAlert, IconWarning,
  IconPlusCircle, IconChevron, IconRefresh, ICON_MD, ICON_LG,
} from '../lib/icons.jsx';

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
      const companies = await api.getCompanies();
      // Load recent movements from the first company, or all companies if possible
      // For the dashboard, grab movements across the first active company with items
      const firstCo = companies.find(c => c.item_count > 0 && c.active !== false) || companies[0];
      let recent = [];
      if (firstCo) {
        const result = await api.getStockMovements(firstCo.id, 1, 10);
        recent = result.movements || [];
      }
      setData({ companies, recent, firstCo });
    } catch (err) {
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

  const { companies, recent, firstCo } = data;
  const totalLowStock = companies.reduce((s, c) => s + (c.low_stock_count || 0), 0);
  const totalItems    = companies.reduce((s, c) => s + (c.item_count    || 0), 0);

  // Count today's stock in/out from recent movements
  const today = new Date().toDateString();
  const todayIn  = recent.filter(m => new Date(m.created_at).toDateString() === today && Number(m.quantity_delta) > 0).length;
  const todayOut = recent.filter(m => new Date(m.created_at).toDateString() === today && Number(m.quantity_delta) < 0).length;

  return (
    <div className="db-wrap page-enter">

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
        <KpiCard label="Companies"   value={companies.length} Icon={IconCompany}    accent="var(--accent)" />
        <KpiCard label="Stock Items" value={totalItems}       Icon={IconStock}      accent="var(--info)" />
        <KpiCard label="Low Stock"   value={totalLowStock}    Icon={IconAlert}      accent={totalLowStock > 0 ? 'var(--warning)' : 'var(--success)'} />
        <KpiCard label="Stock In Today"  value={todayIn}      Icon={IconStockIn}    accent="var(--success)" />
        <KpiCard label="Stock Out Today" value={todayOut}     Icon={IconStockOut}   accent="var(--danger)" />
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

          {/* Quick actions */}
          <div className="db-card db-actions-card">
            <div className="db-card-title" style={{ marginBottom: 14 }}>Quick Actions</div>
            <div className="db-action-list">
              {[
                { label: 'Stock In',       Icon: IconStockIn,      to: '/transactions' },
                { label: 'Stock Out',      Icon: IconStockOut,     to: '/transactions' },
                { label: 'Manage Stock',   Icon: IconStock,        to: '/stock'        },
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
