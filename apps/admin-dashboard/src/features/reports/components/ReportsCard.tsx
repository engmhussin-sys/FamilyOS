import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { devicesApi, DEVICES_QUERY_KEY } from '../../devices/api/devicesApi';
import { reportsApi } from '../api/reportsApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
// A2: shared four-state boundary — a failed report read used to render
// nothing at all under the device buttons.
import { AsyncBoundary, LoadingBlock } from '../../../shared/components/AsyncState';

export function ReportsCard() {
  const { t } = useTranslation();
  const { data: devices } = useQuery({ queryKey: DEVICES_QUERY_KEY, queryFn: devicesApi.list });
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const selectedDevice = devices?.find((d) => d.id === selectedDeviceId);

  const { data: report, isLoading, error, refetch } = useQuery({
    queryKey: ['report', selectedDeviceId],
    // `selectedDevice`, not `selectedDeviceId`. The query reads
    // `selectedDevice.childId`, and the two can disagree: the device list
    // refetches, and a device that was unpaired or deleted while this card was
    // open leaves an id selected with no row behind it. The gate now names the
    // thing the query actually dereferences.
    queryFn: () => reportsApi.getReport(selectedDevice!.childId, selectedDevice!.id),
    enabled: !!selectedDevice,
  });

  if (!devices || devices.length === 0) return null;

  async function handleExport() {
    if (!selectedDevice) return;
    setIsExporting(true);
    try {
      await reportsApi.downloadCsv(selectedDevice.childId, selectedDevice.id, `report-${selectedDevice.childFirstName}.csv`);
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('reports.title')}</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {devices.map((device) => (
          <Button
            key={device.id}
            variant={selectedDeviceId === device.id ? 'primary' : 'ghost'}
            onClick={() => setSelectedDeviceId(device.id)}
          >
            {device.childFirstName}
          </Button>
        ))}
      </div>

      {selectedDevice && (
        <div className="mt-3">
          <AsyncBoundary
            isLoading={isLoading}
            error={error}
            onRetry={() => void refetch()}
            isEmpty={!isLoading && !error && !report}
            skeleton={<LoadingBlock label={t('reports.generating')} />}
          >
            {report && (
        <div className="rounded-card border border-sand-200 p-3 text-sm">
          <p>{t('reports.trustLevel')}: {report.trustLevel ?? t('devices.notSet')}</p>
          <p>{t('reports.dailyLimit')}: {report.screenTimePolicy?.dailyLimitMinutes ?? t('devices.notSet')}</p>
          <p>{t('reports.recentViolations')}: {report.recentViolationCount}</p>
          <Button className="mt-3" variant="secondary" onClick={handleExport} isLoading={isExporting}>
            {t('reports.exportCsv')}
          </Button>
        </div>
            )}
          </AsyncBoundary>
        </div>
      )}
    </Card>
  );
}
