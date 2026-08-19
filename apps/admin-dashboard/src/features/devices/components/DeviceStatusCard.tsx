import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { devicesApi, DEVICES_QUERY_KEY } from '../api/devicesApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import type { DeviceHealthDiagnosis } from '../../../shared/types/api';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { AsyncBoundary } from '../../../shared/components/AsyncState';

const RISK_COLORS: Record<string, string> = {
  LOW: 'bg-sage-100 text-sage-700',
  MEDIUM: 'bg-amber-100 text-amber-700',
  HIGH: 'bg-brick-100 text-brick-700',
  CRITICAL: 'bg-brick-500 text-white',
  UNKNOWN: 'bg-sand-100 text-ink-soft',
};

function RiskBadge({ level }: { level: string }) {
  const classes = RISK_COLORS[level] ?? RISK_COLORS.UNKNOWN;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>{level}</span>;
}

function useFormatLastSeen() {
  const { t } = useTranslation();
  return (lastSeenAt: string | null): string => {
    if (!lastSeenAt) return t('devices.notSeenYet');
    const diffMs = Date.now() - new Date(lastSeenAt).getTime();
    const diffMinutes = Math.floor(diffMs / 60_000);
    if (diffMinutes < 1) return t('devices.seenNow');
    if (diffMinutes < 60) return t('devices.seenMinutesAgo', { minutes: diffMinutes });
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return t('devices.seenHoursAgo', { hours: diffHours });
    return t('devices.seenDaysAgo', { days: Math.floor(diffHours / 24) });
  };
}

export function DeviceStatusCard() {
  const { t } = useTranslation();
  const formatLastSeen = useFormatLastSeen();
  const { data: devices, isLoading, error, refetch } = useQuery({
    queryKey: DEVICES_QUERY_KEY,
    queryFn: devicesApi.list,
  });

  const [openDiagnosisFor, setOpenDiagnosisFor] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<Record<string, DeviceHealthDiagnosis>>({});
  const [loadingDiagnosisFor, setLoadingDiagnosisFor] = useState<string | null>(null);

  async function loadDiagnosis(deviceId: string) {
    setOpenDiagnosisFor(deviceId);
    if (diagnosis[deviceId]) return;
    setLoadingDiagnosisFor(deviceId);
    try {
      const result = await devicesApi.getHealth(deviceId);
      setDiagnosis((prev) => ({ ...prev, [deviceId]: result }));
    } finally {
      setLoadingDiagnosisFor(null);
    }
  }

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('devices.title')}</h2>

      <div className="mt-4 flex flex-col gap-3">
        {/* A2: loading / error / empty / data decided by the shared boundary.
            The B3 envelope (code + requestId) now reaches the operator here,
            where a hand-written line used to say only "could not load". */}
        <AsyncBoundary
          isLoading={isLoading}
          error={error}
          onRetry={() => void refetch()}
          isEmpty={devices?.length === 0}
          emptyHint={t('devices.empty')}
        >
        {devices?.map((device) => (
          <div key={device.id} className="rounded-card border border-sand-200 px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-ink">
                  {t('devices.deviceOf', { name: device.childFirstName })} — {device.platform}
                </p>
                <p className="text-xs text-ink-soft">
                  {formatLastSeen(device.lastSeenAt)} · {t('devices.trust')}: {device.trustLevel ?? t('devices.notSet')}
                </p>
              </div>
              <RiskBadge level={device.riskLevel} />
            </div>

            {device.capabilities && (
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-ink-soft">
                <span>{device.capabilities.manufacturer} {device.capabilities.model}</span>
                <span>· Android API {device.capabilities.sdkInt}</span>
                {!device.capabilities.accessibilityEnabled && (
                  <span className="text-brick-600">· {t('devices.accessibilityDisabledShort')}</span>
                )}
              </div>
            )}

            <div className="mt-2 flex items-center gap-1.5 text-xs">
              <span className="text-ink-soft">{t('devices.protectionActive')}:</span>
              {device.runtimeStatus.enforcementActive === true ? (
                <span className="rounded-full bg-sage-100 px-2 py-0.5 font-medium text-sage-700">
                  {t('devices.protectionActive')}
                </span>
              ) : device.runtimeStatus.accessibilityServiceEnabled === false ? (
                <span className="rounded-full bg-brick-100 px-2 py-0.5 font-medium text-brick-700">
                  {t('devices.protectionDisabled')}
                </span>
              ) : (
                <span className="rounded-full bg-sand-100 px-2 py-0.5 font-medium text-ink-soft">
                  {t('devices.protectionUnknown')}
                </span>
              )}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Button variant="ghost" onClick={() => loadDiagnosis(device.id)}>
                {t('devices.aiDiagnosis')}
              </Button>
            </div>

            {openDiagnosisFor === device.id && (
              <div className="mt-2 rounded-card bg-sand-50 p-3 text-sm text-ink">
                {loadingDiagnosisFor === device.id && <p className="text-ink-soft">{t('devices.analyzing')}</p>}
                {diagnosis[device.id] && <p>{diagnosis[device.id].summary}</p>}
              </div>
            )}
          </div>
        ))}
        </AsyncBoundary>
      </div>
    </Card>
  );
}
