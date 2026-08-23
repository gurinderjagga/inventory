import { createContext, useContext, useState, useCallback } from 'react';
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

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((type, message, title) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, type, message, title }]);
    setTimeout(() => removeToast(id), 4000);
  }, [removeToast]);

  const toast = {
    success: (msg, title) => addToast('success', msg, title),
    error:   (msg, title) => addToast('error',   msg, title),
    warning: (msg, title) => addToast('warning', msg, title),
    info:    (msg, title) => addToast('info',    msg, title),
  };

  const toastRoot = document.getElementById('toast-root');

  return (
    <ToastContext.Provider value={{ toast }}>
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
