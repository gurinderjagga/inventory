import { useEffect, useRef, useState, useId } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { backdropVariants, modalVariants } from '../lib/motion.js';
import { IconClose, IconWarning, ICON_MD } from '../lib/icons.jsx';

/** Everything that can hold focus inside the dialog, in tab order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Generic modal — rendered via portal into #modal-root
 *
 * Props:
 *   isOpen, onClose, title, size ('modal-lg'|'modal-xl'|''), children, footer
 *   onSubmit  — when given, the body and footer are wrapped in a real <form>,
 *               so Enter submits from any field. Every button in `footer` that
 *               is not the submit action must set type="button".
 *   dirty     — when true, dismissing by backdrop click or Escape asks before
 *               throwing the work away.
 */
export default function Modal({
  isOpen, onClose, title, size = '', children, footer, onSubmit, dirty = false,
}) {
  const dialogRef  = useRef(null);
  const returnRef  = useRef(null);
  const titleId    = useId();
  const [askingDiscard, setAskingDiscard] = useState(false);

  // Backdrop clicks and Escape are the accidental dismissals — a stray click
  // beside a half-filled invoice used to bin the whole thing. The × and Cancel
  // buttons stay immediate: those are labelled, deliberate choices.
  const attemptClose = () => {
    if (dirty) { setAskingDiscard(true); return; }
    onClose();
  };

  // Reset the prompt whenever the dialog opens or closes, so a previous
  // "discard?" never greets the next opening.
  useEffect(() => { if (!isOpen) setAskingDiscard(false); }, [isOpen]);

  // Remember what had focus, and give it back on close — otherwise focus is
  // dropped at the top of the document and keyboard users restart every time.
  //
  // Captured during the render that opens the dialog, NOT in an effect: a
  // field with autoFocus is focused during the same commit, before effects
  // run, so an effect would record the modal's own input as the thing to
  // return to and leave focus on <body> at the end.
  const wasOpen = useRef(false);
  if (isOpen && !wasOpen.current) returnRef.current = document.activeElement;
  wasOpen.current = isOpen;

  useEffect(() => {
    if (!isOpen) return;
    return () => {
      const el = returnRef.current;
      if (el && document.contains(el) && typeof el.focus === 'function') el.focus();
    };
  }, [isOpen]);

  // Escape to close, and keep Tab inside the dialog. Without the trap, Tab
  // walks straight out into the page behind the modal.
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (askingDiscard) { setAskingDiscard(false); return; }
        attemptClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const nodes = dialogRef.current?.querySelectorAll(FOCUSABLE);
      if (!nodes?.length) return;
      const first = nodes[0];
      const last  = nodes[nodes.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has escaped already.
      if (!dialogRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [isOpen, askingDiscard, dirty, onClose]);

  // Stop the page behind the modal from scrolling while it is open.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [isOpen]);

  const root = document.getElementById('modal-root');
  if (!root) return null;

  const body = (
    <>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-footer">{footer}</div>}
    </>
  );

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
          onClick={(e) => { if (e.target === e.currentTarget) attemptClose(); }}
        >
          <motion.div
            className={`modal ${size}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            ref={dialogRef}
            variants={modalVariants}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <div className="modal-header">
              <h3 className="modal-title" id={titleId}>{title}</h3>
              <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
                <IconClose size={ICON_MD} />
              </button>
            </div>

            {askingDiscard ? (
              <div className="modal-discard" role="alertdialog" aria-label="Discard changes">
                <IconWarning size={ICON_MD} />
                <div className="modal-discard-text">
                  <strong>Discard your changes?</strong>
                  <span>What you have entered here will be lost.</span>
                </div>
                <div className="modal-discard-actions">
                  <button type="button" className="btn btn-secondary"
                          onClick={() => setAskingDiscard(false)} autoFocus>
                    Keep editing
                  </button>
                  <button type="button" className="btn btn-danger"
                          onClick={() => { setAskingDiscard(false); onClose(); }}>
                    Discard
                  </button>
                </div>
              </div>
            ) : onSubmit ? (
              // A real form, so Enter submits from any field instead of doing
              // nothing and sending the user hunting for the footer button.
              //
              // noValidate matches the login form: every page already reports
              // its own errors inline, and without this the browser silently
              // blocks the submit with a native bubble instead — so the
              // handler never runs and the app's own message never appears.
              <form noValidate onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>{body}</form>
            ) : body}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    root
  );
}
