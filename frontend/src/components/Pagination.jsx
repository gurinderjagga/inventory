import { useState, useEffect, useMemo } from 'react';

export const PAGE_SIZE = 25;

/**
 * Client-side paging for the data tables.
 *
 * Every table rendered every row it had. That is fine at three invoices and
 * steadily worse at three thousand — the cost arrives quietly, long after the
 * code looks finished.
 *
 * Returns the visible slice plus the control to render under the table.
 * Resets to page 1 whenever the row count changes, so filtering never strands
 * the user on a page that no longer exists.
 */
export function usePagination(rows, pageSize = PAGE_SIZE) {
  const [page, setPage] = useState(1);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current   = Math.min(page, pageCount);

  useEffect(() => { setPage(1); }, [rows.length]);

  const visible = useMemo(
    () => (rows.length <= pageSize ? rows : rows.slice((current - 1) * pageSize, current * pageSize)),
    [rows, current, pageSize]
  );

  return {
    visible,
    page: current,
    pageCount,
    setPage,
    total: rows.length,
    // Nothing to page through — let callers skip the control entirely.
    needed: rows.length > pageSize,
    from: (current - 1) * pageSize + 1,
    to: Math.min(current * pageSize, rows.length),
  };
}

/** Props: the object returned by usePagination, plus `noun`. */
export default function Pagination({ page, pageCount, setPage, total, needed, from, to, noun = 'rows' }) {
  if (!needed) return null;

  return (
    <nav className="pagination" aria-label={`${noun} pages`}>
      <span className="pagination-count">
        Showing <strong>{from}–{to}</strong> of {total} {noun}
      </span>
      <div className="pagination-controls">
        <button type="button" className="btn btn-secondary btn-sm"
                onClick={() => setPage(page - 1)} disabled={page <= 1}>
          Previous
        </button>
        <span className="pagination-page">Page {page} of {pageCount}</span>
        <button type="button" className="btn btn-secondary btn-sm"
                onClick={() => setPage(page + 1)} disabled={page >= pageCount}>
          Next
        </button>
      </div>
    </nav>
  );
}
