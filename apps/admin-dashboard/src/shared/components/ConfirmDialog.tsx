import { useEffect, useRef, type ReactNode } from 'react';

import { useTranslation } from '../i18n/LocaleProvider';
import { Button } from './Button';

/**
 * ===========================================================================
 * THE CONFIRMATION THAT REPLACES `window.confirm`.
 * ===========================================================================
 *
 * There was exactly one confirmation in this dashboard before this file, and
 * it was `window.confirm(t('grants.revokeConfirm'))` inside the grant panel.
 * Three things were wrong with it, and all three matter on an operator console:
 *
 *   IT CANNOT BE READ IN ARABIC PROPERLY. The browser chrome renders the
 *   string in the BROWSER's locale and direction, not the page's, so an
 *   Arabic sentence lands in an LTR box with English OK/Cancel buttons.
 *
 *   IT CANNOT SAY WHAT THE ACTION WILL DO. A native confirm is one string. The
 *   actions on this console — revoke every entitlement on a household, force a
 *   sweep that deletes rows, disable a job — need the blast radius written out,
 *   and "are you sure?" over an invisible blast radius is not a confirmation.
 *
 *   IT BLOCKS THE EVENT LOOP, so it cannot show what is already in flight.
 *
 * ── WHY THERE IS NO PORTAL ─────────────────────────────────────────────
 *
 * The dialog renders in place, fixed to the viewport. It does not need to
 * escape a stacking context because nothing in this app creates one above the
 * sticky header (`z-10`), and a portal would put the node outside the
 * `LocaleProvider`'s `dir` subtree only to have to re-establish it.
 *
 * ── WHAT IT GUARANTEES ─────────────────────────────────────────────────
 *
 *   `role="dialog"` + `aria-modal` + a label, so it is announced as a dialog.
 *   FOCUS MOVES INTO IT on open, and Escape closes it — a confirmation an
 *   operator cannot dismiss from the keyboard is a trap, not a safeguard.
 *   The DESTRUCTIVE button is never the one focus lands on. Focus goes to
 *   cancel, so a stray Enter is a no-op rather than a revocation.
 */

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What will actually happen, in the operator's language. Not "are you sure". */
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Red styling and the wording of a danger zone. */
  destructive?: boolean;
  /** True while the mutation is in flight: both buttons lock, nothing double-fires. */
  isPending?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive = false,
  isPending = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus the SAFE button, never the destructive one.
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* The backdrop is a button so a pointer user can dismiss by clicking
          outside, without inventing a keyboard affordance Escape already
          provides. `aria-hidden` keeps it out of the reading order. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-ink/40 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative w-full max-w-md rounded-card border border-sand-200 bg-white p-6 shadow-lg"
      >
        <h2 id="confirm-dialog-title" className={`text-base font-medium ${destructive ? 'text-brick-600' : 'text-ink'}`}>
          {title}
        </h2>
        <div className="mt-2 text-sm text-ink-soft">{body}</div>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} isLoading={isPending}>
            {isPending ? t('common.working') : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
