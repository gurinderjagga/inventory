import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { backdropVariants, modalVariants } from '../lib/motion.js';
import { IconClose, ICON_MD } from '../lib/icons.jsx';

/**
 * Generic modal — rendered via portal into #modal-root
 * Props: isOpen, onClose, title, size ('modal-lg'|'modal-xl'|''), children, footer (ReactNode)
 */
export default function Modal({ isOpen, onClose, title, size = '', children, footer }) {
  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [isOpen, onClose]);

  // Stop the page behind the modal from scrolling while it is open.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [isOpen]);

  const root = document.getElementById('modal-root');
  if (!root) return null;

  // AnimatePresence must render on every pass — not behind an early return —
  // or the exit animation never gets the chance to play.
  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="modal-backdrop"
          variants={backdropVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className={`modal ${size}`}
            role="dialog"
            aria-modal="true"
            variants={modalVariants}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <div className="modal-header">
              <h3 className="modal-title">{title}</h3>
              <button className="modal-close" onClick={onClose} aria-label="Close">
                <IconClose size={ICON_MD} />
              </button>
            </div>
            <div className="modal-body">{children}</div>
            {footer && <div className="modal-footer">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    root
  );
}
