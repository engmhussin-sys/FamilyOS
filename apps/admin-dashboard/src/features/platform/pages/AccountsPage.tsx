import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { AsyncBoundary } from '../../../shared/components/AsyncState';
import {
  ENTITLEMENT_KEYS,
  platformAccountsApi,
  type AccountRow,
  type EntitlementKey,
} from '../api/platformAccountsApi';

/**
 * ===========================================================================
 * THE PLATFORM OWNER'S CONSOLE — who is on the platform, and one lever.
 * ===========================================================================
 *
 * WHAT IT REPLACES. Nothing: before this page every platform-wide view in the
 * dashboard rendered an AGGREGATE. «1,204 families» cannot tell an owner which
 * household is stuck on PENDING_VERIFICATION, which stopped reporting a month
 * ago, or which one just emailed them. This lists them.
 *
 * IT SITS BEHIND BOTH GATES — the parent session and then `AdminKeyGate`,
 * exactly like every `/growth/*` screen — because the two endpoints it reads
 * are behind `InternalAdminGuard` on the backend. The operator key lives in
 * memory only and dies with the page; see `adminKeyStore`.
 *
 * THE ONE ACTION IT OFFERS is a time-boxed manual grant, and its opposite. It
 * is here rather than on a page of its own because the decision needs the row:
 * granting a plan to an email typed from memory, with no sight of what that
 * household already has, is how a comp gets applied twice or to the wrong
 * family.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW: any child's name or date of birth. The
 * endpoint does not return them — asserted in
 * `test/system-diagnostics/accounts-console.e2e.spec.ts` — and an operator
 * console is exactly the place where "we could show it" must not become
 * "we show it".
 */
export function AccountsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  // A stack, not a single cursor: keyset pagination can go forward cheaply and
  // backward only by remembering where it has been.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [selected, setSelected] = useState<AccountRow | null>(null);

  const accounts = useQuery({
    queryKey: ['platform-accounts', appliedSearch, cursors[pageIndex]],
    queryFn: () =>
      platformAccountsApi.list({
        limit: 25,
        cursor: cursors[pageIndex],
        search: appliedSearch || null,
      }),
  });

  const rows = accounts.data?.rows ?? [];

  function runSearch(next: string) {
    setAppliedSearch(next);
    setCursors([null]);
    setPageIndex(0);
  }

  return (
    <section className="platform-accounts">
      <header>
        <h1>{t('accounts.title')}</h1>
        <p>{t('accounts.intro')}</p>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          runSearch(search.trim());
        }}
      >
        <label htmlFor="accounts-search">{t('accounts.search')}</label>
        <input
          id="accounts-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('accounts.searchPlaceholder')}
        />
        <button type="submit">{t('accounts.searchAction')}</button>
        {appliedSearch ? (
          <button
            type="button"
            onClick={() => {
              setSearch('');
              runSearch('');
            }}
          >
            {t('accounts.clear')}
          </button>
        ) : null}
      </form>

      {/*
        The four states — loading, error, empty, content — belong to
        `AsyncBoundary` and to nothing else. An earlier draft of this page
        hand-rolled all three of the first ones, and `asyncState.spec.tsx`
        failed it by name: nine slightly different loading strings is how a
        dashboard stops looking like one product.
      */}
      <AsyncBoundary
        isLoading={accounts.isLoading}
        error={accounts.isError ? (accounts.error as Error) : null}
        isEmpty={!accounts.isLoading && !accounts.isError && rows.length === 0}
        emptyHint={t('accounts.empty')}
        onRetry={() => accounts.refetch()}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">{t('accounts.household')}</th>
              <th scope="col">{t('accounts.owner')}</th>
              <th scope="col">{t('accounts.status')}</th>
              <th scope="col">{t('accounts.members')}</th>
              <th scope="col">{t('accounts.childrenCount')}</th>
              <th scope="col">{t('accounts.devices')}</th>
              <th scope="col">{t('accounts.plan')}</th>
              <th scope="col">{t('accounts.lastSeen')}</th>
              <th scope="col">{t('accounts.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.familyId}>
                <td>
                  {row.familyName}
                  {row.countryCode ? <span> · {row.countryCode}</span> : null}
                </td>
                <td>{row.ownerEmail ?? '—'}</td>
                <td>{row.ownerStatus ?? '—'}</td>
                <td>{row.memberCount}</td>
                <td>{row.childCount}</td>
                <td>{row.deviceCount}</td>
                <td>
                  {/* The live-grant flag is shown BESIDE the plan, never
                      instead of it: a household on FREE with a live comp is a
                      different situation from one that pays, and an operator
                      deciding whether to extend needs to see which. */}
                  {row.planTier ?? '—'}
                  {row.subscriptionStatus ? <span> · {row.subscriptionStatus}</span> : null}
                  {row.hasLiveEntitlement ? <strong> · {t('accounts.granted')}</strong> : null}
                </td>
                <td>{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleDateString() : t('accounts.never')}</td>
                <td>
                  <button type="button" disabled={!row.ownerEmail} onClick={() => setSelected(row)}>
                    {t('accounts.manage')}
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
        </table>
      </AsyncBoundary>

      <nav>
        <button type="button" disabled={pageIndex === 0} onClick={() => setPageIndex((index) => index - 1)}>
          {t('accounts.previous')}
        </button>
        <button
          type="button"
          disabled={!accounts.data?.nextCursor}
          onClick={() => {
            const next = accounts.data?.nextCursor ?? null;
            setCursors((stack) => (stack[pageIndex + 1] === next ? stack : [...stack.slice(0, pageIndex + 1), next]));
            setPageIndex((index) => index + 1);
          }}
        >
          {t('accounts.next')}
        </button>
      </nav>

      {selected && selected.ownerEmail ? (
        <GrantPanel
          email={selected.ownerEmail}
          familyName={selected.familyName}
          onClose={() => setSelected(null)}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ['platform-accounts'] })}
        />
      ) : null}
    </section>
  );
}

/**
 * THE GRANT PANEL. Named features rather than a plan tier, deliberately: the
 * tier path reads `plan_definitions`, which no migration seeds, so on a fresh
 * environment granting a tier writes nothing and the backend answers
 * `PLAN_CATALOGUE_EMPTY`. The six keys are a closed vocabulary in code and work
 * everywhere.
 */
function GrantPanel({
  email,
  familyName,
  onClose,
  onChanged,
}: {
  email: string;
  familyName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [features, setFeatures] = useState<EntitlementKey[]>(['multiple_children']);
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const state = useQuery({
    queryKey: ['platform-entitlements', email],
    queryFn: () => platformAccountsApi.entitlements(email),
  });

  const grant = useMutation({
    mutationFn: () => platformAccountsApi.grantFeatures({ email, features, planTier: 'PREMIUM', days, reason }),
    onSuccess: (result) => {
      setMessage(`${t('grants.granted')} — ${new Date(result.validUntil).toLocaleDateString()}`);
      state.refetch();
      onChanged();
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const revoke = useMutation({
    mutationFn: () => platformAccountsApi.revoke({ email, reason }),
    onSuccess: (result) => {
      setMessage(`${t('grants.revoked')} — ${result.revokedCount}`);
      state.refetch();
      onChanged();
    },
    onError: (error: Error) => setMessage(error.message),
  });

  // Both buttons need a reason: it is what the audit row carries, and an
  // audit row whose reason is blank answers nothing months later.
  const canSubmit = reason.trim().length >= 3 && !grant.isPending && !revoke.isPending;

  const live = useMemo(() => state.data?.features ?? [], [state.data]);

  return (
    <aside aria-label={t('grants.title')}>
      <header>
        <h2>{t('grants.title')}</h2>
        <p>
          {familyName} · {email}
        </p>
        <button type="button" onClick={onClose}>
          {t('common.close')}
        </button>
      </header>

      <p>{t('grants.intro')}</p>

      <section>
        <h3>{t('grants.liveUntil')}</h3>
        <AsyncBoundary
          isLoading={state.isLoading}
          error={state.isError ? (state.error as Error) : null}
          isEmpty={!state.isLoading && !state.isError && live.length === 0}
          emptyHint={t('grants.liveNone')}
          onRetry={() => state.refetch()}
        >
          <p>
            {live.join(', ')}
            {state.data?.validUntil ? ` · ${new Date(state.data.validUntil).toLocaleDateString()}` : ''}
          </p>
        </AsyncBoundary>
      </section>

      <fieldset>
        <legend>{t('grants.features')}</legend>
        {ENTITLEMENT_KEYS.map((key) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={features.includes(key)}
              onChange={(event) =>
                setFeatures((current) =>
                  event.target.checked ? [...current, key] : current.filter((item) => item !== key),
                )
              }
            />
            {key}
          </label>
        ))}
      </fieldset>

      <label htmlFor="grant-days">{t('grants.days')}</label>
      <input
        id="grant-days"
        type="number"
        min={1}
        max={400}
        value={days}
        onChange={(event) => setDays(Number(event.target.value))}
      />

      <label htmlFor="grant-reason">{t('grants.reason')}</label>
      <input id="grant-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
      <p>{t('grants.reasonHint')}</p>

      <button type="button" disabled={!canSubmit || features.length === 0} onClick={() => grant.mutate()}>
        {t('grants.grant')}
      </button>
      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => {
          // Revoking ends EVERY entitlement on the household, including one
          // from a real payment. The confirmation says so rather than asking
          // "are you sure" about an action whose blast radius is invisible.
          if (window.confirm(t('grants.revokeConfirm'))) revoke.mutate();
        }}
      >
        {t('grants.revoke')}
      </button>

      {message ? <p role="status">{message}</p> : null}
    </aside>
  );
}
