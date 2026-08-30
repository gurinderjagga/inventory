import { IconSearch, IconClose, ICON_MD } from '../lib/icons.jsx';

/**
 * The empty panel under a list.
 *
 * Two situations that look identical to the code read very differently to the
 * user, and every page used to conflate them: searching for something that is
 * not there was answered with "No invoices yet — create your first one",
 * which is simply untrue when forty of them are sitting behind the filter.
 *
 * Props:
 *   Icon      — glyph for the genuinely-empty case
 *   query     — current search text; non-empty means this is a no-matches state
 *   onClear   — clears the search
 *   noun      — plural noun for the no-matches line ("invoices")
 *   title,hint— copy for the genuinely-empty case
 */
export default function EmptyState({ Icon, query = '', onClear, noun, title, hint }) {
  if (query) {
    return (
      <div className="empty-state">
        <IconSearch />
        <h3>No {noun} match “{query}”</h3>
        <p>Check the spelling, or clear the search to see everything.</p>
        <button type="button" className="btn btn-secondary" style={{ marginTop: 12 }} onClick={onClear}>
          <IconClose size={ICON_MD} /> Clear search
        </button>
      </div>
    );
  }

  return (
    <div className="empty-state">
      <Icon />
      <h3>{title}</h3>
      <p>{hint}</p>
    </div>
  );
}
