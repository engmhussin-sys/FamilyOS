import type { ReactNode } from 'react';
import { ApiError } from '../../../shared/lib/httpClient';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { Button } from '../../../shared/components/Button';
import type { AdapterGap } from '../api/adapters';

/**
 * Every view on this dashboard has four possible states and all four are
 * built here, once, so no screen can quietly skip one.
 *
 * The distinction that matters most is EMPTY vs ZERO. An empty metric reads
 * "no data yet" and never `0` — the backend's rule 2 says a 45-day-old
 * cohort returns `null` for RETENTION_D90, and a dashboard that renders that
 * as 0% has invented a catastrophic retention figure out of a young cohort.
 */

export function LoadingBlock({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-card border border-sand-200 bg-white/60 p-6 text-sm text-ink-soft"
    >
      <span
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-guardian-700 border-t-transparent"
        aria-hidden="true"
      />
      {label ?? t('growth.state.loading')}
    </div>
  );
}

/**
 * ── SKELETONS ──────────────────────────────────────────────────────────
 *
 * A skeleton, not a spinner, wherever the SHAPE of what is coming is known:
 * the layout does not jump when the data lands, and the operator's eye has
 * already found the tile it is about to read.
 *
 * Deliberately shapes only — no zeros, no dashes, no placeholder digits. A
 * grey bar cannot be misread as a measurement; a `0` can.
 *
 * One `role="status"` per skeleton GROUP, never one per bar, so a screen
 * reader hears "loading" once instead of nine times. `prefers-reduced-motion`
 * kills the pulse globally (see `index.css`).
 */
function Bar({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`block rounded bg-sand-200/70 ${className}`} />;
}

export function SkeletonGroup({ label, children }: { label?: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="animate-pulse">
      <span className="sr-only">{label ?? t('growth.state.loading')}</span>
      {children}
    </div>
  );
}

/** Matches the KpiCard grid: label line, big figure, hint line. */
export function KpiGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SkeletonGroup>
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: count }).map((_, index) => (
          <div key={index} className="rounded-card border border-sand-200 bg-white p-4 shadow-quiet">
            <Bar className="h-3 w-2/5" />
            <Bar className="mt-3 h-7 w-3/5" />
            <Bar className="mt-3 h-2.5 w-1/4" />
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}

/** Matches ChartFrame: header, plot area, legend row. */
export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <SkeletonGroup>
      <div className="rounded-card border border-sand-200 bg-white p-5 shadow-quiet">
        <Bar className="h-3.5 w-1/3" />
        <Bar className="mt-2 h-2.5 w-1/2" />
        <span aria-hidden="true" className="mt-5 block rounded-card bg-sand-200/70" style={{ height }} />
        <div className="mt-4 flex gap-3">
          <Bar className="h-2.5 w-20" />
          <Bar className="h-2.5 w-20" />
          <Bar className="h-2.5 w-20" />
        </div>
      </div>
    </SkeletonGroup>
  );
}

/** Matches a figure grid (a `<dl>` of small labelled numbers). */
export function FigureGridSkeleton({ count = 4, columns = 2 }: { count?: number; columns?: number }) {
  return (
    <SkeletonGroup>
      <div className={`grid gap-3 ${columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        {Array.from({ length: count }).map((_, index) => (
          <div key={index} className="rounded-card border border-sand-200 bg-white px-3 py-2.5">
            <Bar className="h-2.5 w-1/2" />
            <Bar className="mt-2 h-4 w-1/3" />
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}

/**
 * Held during a refetch instead of a skeleton flash: the previous render
 * stays on screen at reduced opacity, so nothing jumps and the operator
 * never loses the number they were reading.
 */
export function RefetchingOverlay({ isFetching, children }: { isFetching: boolean; children: ReactNode }) {
  return (
    <div className={isFetching ? 'opacity-60 transition-opacity duration-200' : 'transition-opacity duration-200'}>
      {children}
    </div>
  );
}

export function EmptyBlock({ hint }: { hint?: string }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-dashed border-sand-200 bg-sand-50/60 p-6 text-center">
      <p className="font-medium text-ink">{t('growth.state.empty')}</p>
      <p className="mt-1 text-sm text-ink-soft">{hint ?? t('growth.state.emptyHint')}</p>
    </div>
  );
}

/**
 * B3 envelope rendering. `messageAr` is shown to an Arabic-reading operator
 * because the backend already wrote the sentence in their language; the
 * English `message` is the fallback, and `requestId` is quoted verbatim
 * because it is the thing a support ticket is actually resolved by.
 */
export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, locale } = useTranslation();
  const apiError = error instanceof ApiError ? error : null;
  const text =
    (locale === 'ar' ? apiError?.messageAr : undefined) ??
    apiError?.message ??
    (error instanceof Error ? error.message : t('growth.state.error'));

  return (
    <div role="alert" className="rounded-card border border-brick-500/40 bg-brick-100/50 p-6">
      <p className="font-medium text-brick-600">{t('growth.state.error')}</p>
      <p className="mt-1 text-sm text-ink-soft">{text}</p>
      {apiError?.code && <p className="mt-2 font-mono text-xs text-ink-soft">{apiError.code}</p>}
      {apiError?.requestId && (
        <p className="mt-1 font-mono text-xs text-ink-soft">
          {t('growth.state.requestId')}: {apiError.requestId}
        </p>
      )}
      {onRetry && (
        <Button variant="secondary" className="mt-4" onClick={onRetry}>
          {t('growth.state.retry')}
        </Button>
      )}
    </div>
  );
}

/**
 * The fifth state, and the one this dashboard needed a component for: a
 * number the brief asks for that no endpoint provides. It renders as an
 * explicit absence with the proposed contract written on it — never as a
 * zero, and never as a plausible-looking placeholder.
 */
export function GapBlock({ gap }: { gap: AdapterGap }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-dashed border-amber-500/60 bg-amber-100/40 p-5">
      <p className="text-sm font-medium text-amber-600">{t('growth.state.endpointMissing')}</p>
      <p className="mt-1 text-sm text-ink-soft">{t(gap.reasonKey)}</p>
      <p className="mt-2 text-xs text-ink-soft">
        {t('growth.state.proposedEndpoint')}:{' '}
        <code className="font-mono" dir="ltr">
          {gap.proposedEndpoint}
        </code>
      </p>
    </div>
  );
}

/** Shown under a composed figure, so an operator can see the number was
 * assembled on the client rather than read from one authoritative row. */
export function ComposedFromNote({ endpoints }: { endpoints: string[] }) {
  const { t } = useTranslation();
  return (
    <p className="mt-2 text-xs text-ink-soft">
      {t('growth.state.composedFrom')}:{' '}
      <code className="font-mono" dir="ltr">
        {endpoints.join(' + ')}
      </code>
    </p>
  );
}

interface AsyncBoundaryProps {
  isLoading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyHint?: string;
  onRetry?: () => void;
  /** The shape of what is loading. Pass one wherever the layout is known —
   * the bare `LoadingBlock` stays the fallback for panels whose shape is
   * genuinely unpredictable. */
  skeleton?: ReactNode;
  children: ReactNode;
}

/** One place that decides which of the four states a panel is in. */
export function AsyncBoundary({
  isLoading,
  error,
  isEmpty,
  emptyHint,
  onRetry,
  skeleton,
  children,
}: AsyncBoundaryProps) {
  if (isLoading) return <>{skeleton ?? <LoadingBlock />}</>;
  if (error) return <ErrorBlock error={error} onRetry={onRetry} />;
  if (isEmpty) return <EmptyBlock hint={emptyHint} />;
  return <>{children}</>;
}
