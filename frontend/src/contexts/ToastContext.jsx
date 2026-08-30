import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { toastVariants } from '../lib/motion.js';
import { IconSuccess, IconError, IconWarning, IconInfo, IconClose, ICON_MD } from '../lib/icons.jsx';

const ToastContext = createContext(null);

const ICONS = {
  success: IconSuccess,
  error:   IconError,
  warning: IconWarning,
  info:    IconInfo,
};

const TITLES = {
  success: 'Success',
  error:   'Error',
  warning: 'Warning',
  info:    'Info',
};

/**
 * How long each kind of toast survives, in ms.
 *
 * Errors never expire on their own. They are the only messages that carry
 * something the user has to act on — "Insufficient stock for X. Available: 3,
 * Requested: 10" is a set of numbers to work from, and it used to vanish after
 * four seconds with no history and no way to bring it back. Warnings get a
 * longer window for the same reason; confirmations stay brief.
 */
const AUTO_DISMISS_MS = {
  success: 4000,
  info:    4000,
  warning: 8000,
  error:   null,   // sticky — dismissed by the user, never by a timer
};

/** Beyond this the stack covers the page; the oldest is dropped to make room. */
const MAX_TOASTS = 4;

function ToastItem({ id, type, message, title, onRemove }) {
  const sticky = AUTO_DISMISS_MS[type] === null;
  return (
    <motion.div
      className={`toast toast-${type}`}
      // Errors are announced immediately; the rest wait for a pause. The role
      // lives on the toast rather than the container so each message gets the
      // urgency it deserves.
      role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
      variants={toastVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      // Collapses the gap smoothly as neighbours leave the stack.
      layout
    >
      {(() => { const Glyph = ICONS[type]; return <Glyph size={ICON_MD} className="toast-icon" />; })()}
      <div className="toast-content">
        <div className="toast-title">{title || TITLES[type]}</div>
        {message && <div className="toast-msg">{message}</div>}
      </div>
      {/* A real button, not a click-anywhere div: the old toast was dismissible
          only by mouse and gave no sign that it was dismissible at all. */}
      <button
        type="button"
        className="toast-close"
        onClick={() => onRemove(id)}
        aria-label={`Dismiss ${(title || TITLES[type]).toLowerCase()} message`}
      >
        <IconClose size={sticky ? ICON_MD : 14} />
      </button>
    </motion.div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  // Auto-dismiss timers, keyed by toast id, so they can be cancelled when a
  // toast is dismissed early or the provider unmounts.
  const timers = useRef(new Map());
  const nextId = useRef(0);

  const removeToast = useCallback((id) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((type, message, title) => {
    const id = nextId.current++;
    setToasts((prev) => {
      const next = [...prev, { id, type, message, title }];
      // Sticky errors can pile up, so make room by dropping the oldest — and
      // clear its timer, since it may still have one pending.
      while (next.length > MAX_TOASTS) {
        const dropped = next.shift();
        const timer = timers.current.get(dropped.id);
        if (timer) { clearTimeout(timer); timers.current.delete(dropped.id); }
      }
      return next;
    });

    const ttl = AUTO_DISMISS_MS[type];
    if (ttl != null) {
      timers.current.set(id, setTimeout(() => removeToast(id), ttl));
    }
  }, [removeToast]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  // `toast` and the context value MUST be referentially stable.
  //
  // Pages build their data loaders with useCallback(…, [toast]) and run them
  // from useEffect. When this object was rebuilt on every render, showing a
  // toast changed its identity, which rebuilt the loader, which re-ran the
  // effect and refetched — twice per toast, once on show and once on the
  // auto-dismiss. Worse, a toast raised *by* a failing load re-triggered that
  // same load, giving an endless request loop whenever the API was unhappy.
  //
  // addToast is stable (removeToast has no dependencies), so these memos never
  // recompute and a toast can no longer invalidate anything downstream.
  const toast = useMemo(() => ({
    success: (msg, title) => addToast('success', msg, title),
    error:   (msg, title) => addToast('error',   msg, title),
    warning: (msg, title) => addToast('warning', msg, title),
    info:    (msg, title) => addToast('info',    msg, title),
  }), [addToast]);

  const value = useMemo(() => ({ toast }), [toast]);

  const toastRoot = typeof document !== 'undefined'
    ? document.getElementById('toast-root')
    : null;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toastRoot && createPortal(
        // No aria-live here: each toast carries its own role, so nesting a
        // live region would make screen readers announce twice.
        <div id="toast-container">
          <AnimatePresence initial={false}>
            {toasts.map(t => (
              <ToastItem key={t.id} {...t} onRemove={removeToast} />
            ))}
          </AnimatePresence>
        </div>,
        toastRoot
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
