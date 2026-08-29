import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

const ToastContext = createContext(null);

const ICONS = {
  success: 'bi-check-circle-fill',
  error:   'bi-x-circle-fill',
  warning: 'bi-exclamation-triangle-fill',
  info:    'bi-info-circle-fill',
};

const TITLES = {
  success: 'Success',
  error:   'Error',
  warning: 'Warning',
  info:    'Info',
};

const AUTO_DISMISS_MS = 4000;

function ToastItem({ id, type, message, title, onRemove }) {
  return (
    <div className={`toast toast-${type}`} onClick={() => onRemove(id)}>
      <i className={`bi ${ICONS[type]} toast-icon`} />
      <div className="toast-content">
        <div className="toast-title">{title || TITLES[type]}</div>
        {message && <div className="toast-msg">{message}</div>}
      </div>
    </div>
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
    setToasts(prev => [...prev, { id, type, message, title }]);
    timers.current.set(id, setTimeout(() => removeToast(id), AUTO_DISMISS_MS));
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
        <div id="toast-container" aria-live="polite">
          {toasts.map(t => (
            <ToastItem key={t.id} {...t} onRemove={removeToast} />
          ))}
        </div>,
        toastRoot
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
