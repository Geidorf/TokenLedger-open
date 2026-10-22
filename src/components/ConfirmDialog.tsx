import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ConfirmationRequest } from '../utils/confirmation';
import { focusWrapTarget } from '../utils/frontendContracts';

interface ConfirmDialogProps extends ConfirmationRequest {
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'primary',
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    const dialog = dialogRef.current;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const wrapTarget = focusWrapTarget(
        event.shiftKey ? 'backward' : 'forward',
        document.activeElement === first,
        document.activeElement === last,
      );
      if (wrapTarget === 'last') {
        event.preventDefault();
        last.focus();
      } else if (wrapTarget === 'first') {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  const dialog = (
    <div
      className="modal-overlay confirm-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className={`modal-content confirm-dialog confirm-dialog-${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-dialog-icon" aria-hidden="true">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="confirm-dialog-copy">
          <h2 id="confirm-dialog-title" className="confirm-dialog-title">{title}</h2>
          <p id="confirm-dialog-description" className="confirm-dialog-description">{description}</p>
        </div>
        <footer className="confirm-dialog-actions">
          <button ref={cancelRef} className="ghost-inline" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={tone === 'danger' ? 'danger-inline' : 'primary-inline'} type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
}
