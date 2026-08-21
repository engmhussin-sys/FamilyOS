import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { AsyncBoundary } from '../../../shared/components/AsyncState';
import { supportApi } from '../api/platformOpsApi';

/**
 * ===========================================================================
 * THE SUPPORT QUEUE — requests that were being received and never read.
 * ===========================================================================
 *
 * `POST /support` has accepted requests since Sprint 8 and `GET /support` has
 * returned them behind the operator key since a later audit closed that gap.
 * Nothing displayed them, so in practice a household writing in was writing
 * into a table.
 *
 * PRIORITY IS SHOWN FIRST AND IS NOT A CLAIM. `isPriority` is computed at
 * submission time from the household's entitlements and is never
 * client-supplied — it says what they bought, not how urgent they feel. Sorting
 * by it is the only thing this screen does that the raw list does not.
 *
 * THERE IS NO REPLY BUTTON, and that is honest rather than unfinished: this
 * product has no ticketing, no threading and no outbound mail path for support.
 * A reply box here would compose into nothing. The email is shown so an
 * operator can answer from wherever they actually answer.
 */
export function SupportQueuePage() {
  const { t } = useTranslation();
  const [onlyPriority, setOnlyPriority] = useState(false);

  const queue = useQuery({ queryKey: ['support-queue'], queryFn: supportApi.list });

  const rows = useMemo(() => {
    const all = queue.data ?? [];
    const filtered = onlyPriority ? all.filter((row) => row.isPriority) : all;
    // Priority first, then newest. Two paying households waiting is a different
    // queue from one paying and one free, and the order should say so.
    return [...filtered].sort((a, b) => {
      if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [queue.data, onlyPriority]);

  return (
    <section>
      <header>
        <h1>{t('support.title')}</h1>
        <p>{t('support.intro')}</p>
      </header>

      <label>
        <input
          type="checkbox"
          checked={onlyPriority}
          onChange={(event) => setOnlyPriority(event.target.checked)}
        />
        {t('support.onlyPriority')}
      </label>

      <AsyncBoundary
        isLoading={queue.isLoading}
        error={queue.isError ? (queue.error as Error) : null}
        isEmpty={!queue.isLoading && !queue.isError && rows.length === 0}
        emptyHint={t('support.empty')}
        onRetry={() => queue.refetch()}
      >
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              <p>
                {row.isPriority ? <strong>{t('support.priority')} · </strong> : null}
                {row.subject}
              </p>
              <p>
                {row.email} · {new Date(row.createdAt).toLocaleString()}
              </p>
              <p>{row.message}</p>
            </li>
          ))}
        </ul>
      </AsyncBoundary>

      {/*
        The cap is the backend's (200) and is stated rather than hidden: a queue
        that silently truncates reads as "that is all there is", which during a
        bad week is exactly wrong.
      */}
      <p>{t('support.cap')}</p>
    </section>
  );
}
