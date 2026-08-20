import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CHILDREN_QUERY_KEY, childrenApi } from '../../children/api/childrenApi';
import { screenTimeApi, screenTimePolicyQueryKey } from '../api/screenTimeApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { AsyncBoundary, ErrorBlock } from '../../../shared/components/AsyncState';

function ChildPolicyRow({ childId, childFirstName }: { childId: string; childFirstName: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    data: policy,
    isLoading,
    // A2: a failed policy read used to render «لم تُضبط سياسة بعد» — i.e. it
    // told the parent NO LIMIT IS SET when the truth was that the limit could
    // not be read. That is the worst version of this defect on this dashboard,
    // so the failure is now named.
    error: loadError,
    refetch,
  } = useQuery({
    queryKey: screenTimePolicyQueryKey(childId),
    queryFn: () => screenTimeApi.getPolicy(childId),
  });

  const [dailyLimit, setDailyLimit] = useState('');
  const [bedtimeStart, setBedtimeStart] = useState('');
  const [bedtimeEnd, setBedtimeEnd] = useState('');
  const [focusMode, setFocusMode] = useState(false);

  function startEditing() {
    setDailyLimit(policy?.dailyLimitMinutes?.toString() ?? '');
    setBedtimeStart(policy?.bedtimeStart ?? '');
    setBedtimeEnd(policy?.bedtimeEnd ?? '');
    setFocusMode(policy?.focusModeEnabled ?? false);
    setError(null);
    setIsEditing(true);
  }

  async function save() {
    setIsSaving(true);
    setError(null);
    try {
      await screenTimeApi.setPolicy(childId, {
        dailyLimitMinutes: dailyLimit ? Number(dailyLimit) : undefined,
        bedtimeStart: bedtimeStart || undefined,
        bedtimeEnd: bedtimeEnd || undefined,
        focusModeEnabled: focusMode,
      });
      await queryClient.invalidateQueries({ queryKey: screenTimePolicyQueryKey(childId) });
      setIsEditing(false);
    } catch {
      setError(t('screenTime.saveError'));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="rounded-card border border-sand-200 px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="font-medium text-ink">{childFirstName}</p>
        {/* No edit affordance while the current policy is unknown: the editor
            seeds itself from `policy`, so saving after a failed read would
            silently overwrite a limit nobody could see. */}
        {!isEditing && !loadError && (
          <Button variant="ghost" onClick={startEditing}>
            {policy ? t('screenTime.editPolicy') : t('screenTime.setPolicy')}
          </Button>
        )}
      </div>

      {!isEditing && loadError && (
        <div className="mt-2">
          <ErrorBlock error={loadError} onRetry={() => void refetch()} />
        </div>
      )}

      {!isEditing && !isLoading && !loadError && (
        <p className="mt-1 text-xs text-ink-soft">
          {policy
            ? t('screenTime.dailyLimitSummary', { minutes: policy.dailyLimitMinutes ?? t('devices.notSet') })
            : t('screenTime.noPolicySet')}
        </p>
      )}

      {isEditing && (
        <div className="mt-3 flex flex-col gap-3">
          <Input
            label={t('screenTime.dailyLimit')}
            type="number"
            min={0}
            max={1440}
            value={dailyLimit}
            onChange={(e) => setDailyLimit(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('screenTime.bedtimeStart')}
              type="time"
              value={bedtimeStart}
              onChange={(e) => setBedtimeStart(e.target.value)}
            />
            <Input
              label={t('screenTime.bedtimeEnd')}
              type="time"
              value={bedtimeEnd}
              onChange={(e) => setBedtimeEnd(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={focusMode}
              onChange={(e) => setFocusMode(e.target.checked)}
            />
            {t('screenTime.focusMode')}
          </label>

          {error && <p className="text-xs text-brick-600">{error}</p>}

          <div className="flex gap-2">
            <Button onClick={save} isLoading={isSaving}>
              {t('common.save')}
            </Button>
            <Button variant="ghost" onClick={() => setIsEditing(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ScreenTimePolicyCard() {
  const { t } = useTranslation();
  const { data: children, isLoading, error, refetch } = useQuery({
    queryKey: CHILDREN_QUERY_KEY,
    queryFn: childrenApi.list,
  });

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('screenTime.title')}</h2>
      <div className="mt-4 flex flex-col gap-3">
        <AsyncBoundary
          isLoading={isLoading}
          error={error}
          onRetry={() => void refetch()}
          isEmpty={children?.length === 0}
          emptyHint={t('screenTime.empty')}
        >
          {children?.map((child) => (
            <ChildPolicyRow key={child.id} childId={child.id} childFirstName={child.firstName} />
          ))}
        </AsyncBoundary>
      </div>
    </Card>
  );
}
