import { useState, useMemo } from 'react';
import { IconSortAsc, IconSortDesc, IconSortNone } from './icons.jsx';

/**
 * Client-side column sorting for the data tables.
 *
 * None of the tables could be reordered: you could not find the largest
 * invoice or the emptiest shelf without reading every row. The data is already
 * fully loaded for filtering, so sorting it here costs nothing extra.
 *
 * `columns` maps a key to how that column's value is read, e.g.
 *   { total: r => Number(r.total), name: r => r.name }
 * Values that are numbers sort numerically; everything else compares as text.
 */
export function useTableSort(rows, columns, initial = null) {
  // null | { key, dir: 'asc' | 'desc' }
  const [sort, setSort] = useState(initial);

  const sorted = useMemo(() => {
    if (!sort || !columns[sort.key]) return rows;
    const read = columns[sort.key];
    const factor = sort.dir === 'asc' ? 1 : -1;

    // Copy first: Array.prototype.sort mutates, and `rows` is state.
    return [...rows].sort((a, b) => {
      const av = read(a), bv = read(b);

      // Blanks sort last regardless of direction — an empty SKU is not
      // "smaller" than another, it is simply missing.
      const aEmpty = av === null || av === undefined || av === '';
      const bEmpty = bv === null || bv === undefined || bv === '';
      if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1;

      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv), 'en', { numeric: true, sensitivity: 'base' }) * factor;
    });
  }, [rows, sort, columns]);

  // Click cycles asc → desc → unsorted, so the original order is reachable.
  const toggle = (key) => setSort(prev => {
    if (prev?.key !== key) return { key, dir: 'asc' };
    if (prev.dir === 'asc')  return { key, dir: 'desc' };
    return null;
  });

  return { sorted, sort, toggle };
}

/** A sortable column header. Props: sortKey, sort, onToggle, align, children */
export function SortableTh({ sortKey, sort, onToggle, align, children }) {
  const active = sort?.key === sortKey;
  const dir    = active ? sort.dir : null;
  const Glyph  = !active ? IconSortNone : dir === 'asc' ? IconSortAsc : IconSortDesc;

  return (
    <th className={align === 'num' ? 'num' : undefined}
        aria-sort={!active ? 'none' : dir === 'asc' ? 'ascending' : 'descending'}>
      <button
        type="button"
        className={`th-sort${active ? ' active' : ''}`}
        onClick={() => onToggle(sortKey)}
        title={
          !active ? `Sort by ${String(children)}`
          : dir === 'asc' ? `Sort by ${String(children)}, descending`
          : `Remove sorting on ${String(children)}`
        }
      >
        <span>{children}</span>
        <Glyph size={12} className="th-sort-icon" aria-hidden="true" />
      </button>
    </th>
  );
}
