import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, isAuthError } from '../api.js';
import { cached, CACHE_COMPANIES } from '../lib/cache.js';
import { useToast } from '../contexts/ToastContext.jsx';
import { listContainer, listItem } from '../lib/motion.js';
import { formatDate } from '../lib/format.js';
import StockMovementForm from '../components/StockMovementForm.jsx';
import {
  IconCompany, IconRefresh, IconAlert, IconHistory, IconTransactions, ICON_LG, ICON_MD,
} from '../lib/icons.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function reasonLabel(reason) {
  const map = {
    stock_in:          'Stock In',
    stock_out:         'Stock Out',
    initial_stock:     'Opening Balance',
    manual_adjustment: 'Manual Adjustment',
    invoice_finalize:  'Invoice (legacy)',
    invoice_reversal:  'Invoice Reversal (legacy)',
  };
  return map[reason] || reason;
}

function reasonClass(reason) {
  if (reason === 'stock_in'  || reason === 'initial_stock') return 'txn-in';
  if (reason === 'stock_out' || reason === 'invoice_finalize') return 'txn-out';
  return 'txn-neutral';
}

function deltaDisplay(delta) {
  const n = Number(delta);
  return n >= 0 ? `+${n}` : String(n);
}

// ── Movement History ──────────────────────────────────────────────────────────

function MovementHistory({ companies }) {
  const { toast } = useToast();
  const [companyId, setCompanyId] = useState('');
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [pageIndex, setPageIndex] = useState(0); // 0-based, for the "Page N of M" label

  // The movements list is keyset-paginated (see backend/lib/keysetCursor.js) —
  // there's no page number to ask the server for, only "give me what comes
  // after this cursor". Prev/Next here is strictly sequential, so a simple
  // stack of the cursors already seen is enough: cursors[0] is always null
  // (the first page), and cursors[i+1] is whatever page i's response said
  // came next. A ref, not state — it doesn't need to trigger a re-render,
  // only `data`/`pageIndex` do.
  const cursorsRef = useRef([null]);

  const load = useCallback(async (cid, idx) => {
    if (!cid) return;
    setLoading(true);
    try {
      const cursor = cursorsRef.current[idx] ?? null;
      const result = await api.getStockMovements(cid, cursor, 30);
      setData(result);
      setPageIndex(idx);
      if (result.nextCursor) cursorsRef.current[idx + 1] = result.nextCursor;
    } catch (err) {
      if (!isAuthError(err)) toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    cursorsRef.current = [null];
    if (companyId) load(companyId, 0);
    else setData(null);
  }, [companyId, load]);

  return (
    <div className="txn-history">
      <div className="txn-history-toolbar">
        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
          <label className="form-label" htmlFor="hist-company">Company</label>
          <select
            id="hist-company"
            className="form-select"
            value={companyId}
            onChange={e => setCompanyId(e.target.value)}
          >
            <option value="">— select company —</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {companyId && (
          <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }}
                  onClick={() => load(companyId, pageIndex)} disabled={loading}>
            <IconRefresh size={ICON_MD} /> Refresh
          </button>
        )}
      </div>

      {loading && (
        <div className="skeleton-table" style={{ marginTop: 16 }}>
          <div className="skeleton-thead">
            {[1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton-bar" />)}
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
      )}

      {!loading && !companyId && (
        <div className="db-empty" style={{ height: 180 }}>
          <IconCompany size={ICON_LG} /><p>Select a company to view movement history</p>
        </div>
      )}

      {!loading && data && data.movements.length === 0 && (
        <div className="db-empty" style={{ height: 180 }}>
          <IconHistory size={ICON_LG} /><p>No movements found</p>
        </div>
      )}

      {!loading && data && data.movements.length > 0 && (
        <>
          <div className="db-table-wrap" style={{ marginTop: 16 }}>
            <table className="db-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Type</th>
                  <th className="num">Qty Change</th>
                  <th>Reference</th>
                  <th>Note</th>
                  <th>By</th>
                </tr>
              </thead>
              <motion.tbody variants={listContainer} initial="initial" animate="animate">
                {data.movements.map(m => (
                  <motion.tr key={m.id} variants={listItem} className={`txn-row ${reasonClass(m.reason)}`}>
                    <td className="db-secondary db-date">{formatDate(m.created_at, { short: true })}</td>
                    <td><strong>{m.item_name}</strong> <span className="db-secondary">({m.item_unit})</span></td>
                    <td><span className={`txn-badge ${reasonClass(m.reason)}`}>{reasonLabel(m.reason)}</span></td>
                    <td className="num num-strong" style={{ color: Number(m.quantity_delta) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                      {deltaDisplay(m.quantity_delta)}
                    </td>
                    <td className="db-secondary">{m.reference_no || '—'}</td>
                    <td className="db-secondary">{m.note || '—'}</td>
                    <td className="db-secondary">{m.performed_by || '—'}</td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div className="txn-pagination">
              <button className="btn btn-secondary btn-sm"
                      disabled={pageIndex <= 0} onClick={() => load(companyId, pageIndex - 1)}>← Prev</button>
              <span className="db-secondary">Page {pageIndex + 1} of {data.pages}</span>
              {/* `nextCursor` is the authoritative "is there more" — `pages` is
                  only an estimate from the count query, taken alongside the
                  page query rather than in the same snapshot. */}
              <button className="btn btn-secondary btn-sm"
                      disabled={!data.nextCursor} onClick={() => load(companyId, pageIndex + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function StockTransactions() {
  const [tab,       setTab]       = useState('move');
  const [companies, setCompanies] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');

  useEffect(() => {
    cached(CACHE_COMPANIES, () => api.getCompanies())
      .then(rows => setCompanies(rows.filter(c => c.active !== false)))
      .catch(err => { if (!isAuthError(err)) setError(err.message); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="txn-page page-enter">
      <div className="txn-tabs">
        {['Record Movement', 'Movement History'].map(label => (
          <button key={label} className="txn-tab" disabled style={{ opacity: 0.4 }}>{label}</button>
        ))}
      </div>
      <div className="txn-panel txn-panel-full" style={{ marginTop: 16 }}>
        <div className="skeleton-table">
          <div className="skeleton-thead">{[1,2,3,4].map(i=><div key={i} className="skeleton-bar"/>)}</div>
          {[1,2,3].map(i=>(
            <div key={i} className="skeleton-row" style={{opacity:1-i*0.15}}>
              <div className="skeleton-bar"/><div className="skeleton-bar"/><div className="skeleton-bar"/>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
  if (error) return <div className="db-empty" style={{ height: 300 }}><IconAlert size={ICON_LG} /><p>{error}</p></div>;

  return (
    <div className="txn-page page-enter">

      <div className="txn-tabs">
        <button className={`txn-tab${tab === 'move' ? ' active' : ''}`}
                onClick={() => setTab('move')} id="tab-move">
          <IconTransactions size={ICON_MD} /> Record Movement
        </button>
        <button className={`txn-tab${tab === 'history' ? ' active' : ''}`}
                onClick={() => setTab('history')} id="tab-history">
          <IconHistory size={ICON_MD} /> Movement History
        </button>
      </div>

      <AnimatePresence mode="wait">
        {tab === 'move' && (
          <motion.div
            key="move"
            className="txn-panel txn-panel-full"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
          >
            <div className="txn-panel-header">
              <IconTransactions size={ICON_LG} />
              <div>
                <h2 className="txn-panel-title">Record Stock Movement</h2>
                <p className="txn-panel-sub">Receive, dispatch, or correct a count — select existing items or type a new item name to create it</p>
              </div>
            </div>
            <StockMovementForm companies={companies} />
          </motion.div>
        )}

        {tab === 'history' && (
          <motion.div
            key="history"
            className="txn-panel txn-panel-wide"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
          >
            <div className="txn-panel-header">
              <IconHistory size={ICON_LG} />
              <div>
                <h2 className="txn-panel-title">Movement History</h2>
                <p className="txn-panel-sub">All stock movements for a company</p>
              </div>
            </div>
            <MovementHistory companies={companies} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
