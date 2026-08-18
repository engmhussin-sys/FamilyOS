import { useCallback, useEffect, useSyncExternalStore, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { adminKeyStore, type AdminKeyState } from './adminKeyStore';
import { Button } from '../../shared/components/Button';
import { useTranslation } from '../../shared/i18n/LocaleProvider';

/**
 * The React half of the runtime operator key. See `adminKeyStore.ts` for why
 * the secret itself never enters this file's state, props or context: the
 * only thing that crosses into React is `{ hasKey, reason }`.
 */
export function useAdminKeyState(): AdminKeyState {
  return useSyncExternalStore(adminKeyStore.subscribe, adminKeyStore.getSnapshot, adminKeyStore.getSnapshot);
}

/**
 * Wraps the platform-admin views. With no key held it renders the unlock
 * screen INSTEAD of its children, so no admin query is ever mounted without
 * a key — and a 401/403 mid-session unmounts them again, which is what turns
 * "the key was refused" into one calm screen rather than eight red panels.
 *
 * Views that do not need the key (the family surface, settings, the
 * organisation page) never mount this component and are unaffected.
 */
export function AdminKeyGate({ children }: { children: ReactNode }) {
  const { hasKey, reason } = useAdminKeyState();
  const queryClient = useQueryClient();

  useEffect(() => {
    // Answers cached under a key that is no longer held must not survive
    // into the next unlock: a different operator key may be a different
    // level of access, and stale platform numbers are exactly the kind of
    // thing that gets read as current.
    if (!hasKey) {
      queryClient.removeQueries({ queryKey: ['growth'] });
      queryClient.removeQueries({ queryKey: ['platform'] });
    }
  }, [hasKey, queryClient]);

  if (!hasKey) return <AdminUnlockScreen reason={reason} />;
  return <>{children}</>;
}

/** The lock control, for the shell header. Renders nothing when locked. */
export function AdminKeyLockButton() {
  const { t } = useTranslation();
  const { hasKey } = useAdminKeyState();
  if (!hasKey) return null;
  return (
    <Button variant="ghost" onClick={() => adminKeyStore.clear()}>
      {t('adminKey.lock')}
    </Button>
  );
}

/**
 * The unlock screen. One field, one sentence about what happens to the
 * value, and — after a refusal — a calm line that names neither the status
 * code nor the key.
 */
export function AdminUnlockScreen({ reason }: { reason: AdminKeyState['reason'] }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (draft.trim() === '') return;
      adminKeyStore.set(draft);
      // Drop the local copy the input needed the instant it is no longer
      // needed, so the value does not sit in a mounted component's state.
      setDraft('');
    },
    [draft],
  );

  return (
    <div className="mx-auto flex max-w-xl flex-col justify-center py-10">
      <section
        aria-labelledby="admin-unlock-title"
        className="rounded-card border border-sand-200 bg-white p-8 shadow-quiet"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">{t('adminKey.eyebrow')}</p>
        <h2 id="admin-unlock-title" className="mt-2 font-display text-2xl text-ink">
          {t('adminKey.title')}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{t('adminKey.subtitle')}</p>

        {reason === 'REJECTED' && (
          <p
            role="alert"
            className="mt-5 rounded-card border border-amber-500/50 bg-amber-100/50 px-4 py-3 text-sm text-ink"
          >
            {t('adminKey.rejected')}
          </p>
        )}
        {reason === 'LOCKED_BY_OPERATOR' && (
          <p className="mt-5 rounded-card border border-sand-200 bg-sand-50 px-4 py-3 text-sm text-ink-soft">
            {t('adminKey.locked')}
          </p>
        )}

        <form onSubmit={submit} className="mt-6 flex flex-col gap-2">
          <label htmlFor="admin-operator-key" className="text-sm font-medium text-ink">
            {t('adminKey.label')}
          </label>
          <input
            id="admin-operator-key"
            // `password`: nothing shoulder-readable, and no browser
            // heuristic that would offer to remember it as a username.
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            // Every persistence hint a browser has, turned off — an
            // autofilled admin secret is a stored admin secret.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-lpignore="true"
            dir="ltr"
            className="rounded-card border border-sand-200 bg-white px-3.5 py-2.5 font-mono text-sm text-ink transition-colors focus:border-sage-500"
            aria-describedby="admin-unlock-note"
          />
          <p id="admin-unlock-note" className="mt-1 text-xs leading-relaxed text-ink-soft">
            {t('adminKey.storageNote')}
          </p>
          <Button type="submit" className="mt-3 self-start" disabled={draft.trim() === ''}>
            {t('adminKey.submit')}
          </Button>
        </form>
      </section>
    </div>
  );
}
