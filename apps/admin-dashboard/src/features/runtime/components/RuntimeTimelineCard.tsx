import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { devicesApi, DEVICES_QUERY_KEY } from '../../devices/api/devicesApi';
import { runtimeApi, timelineQueryKey } from '../api/runtimeApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';

function TimelineList({ deviceId }: { deviceId: string }) {
  const { data: events, isLoading } = useQuery({
    queryKey: timelineQueryKey(deviceId),
    queryFn: () => runtimeApi.getTimeline(deviceId),
  });

  if (isLoading) return <p className="text-sm text-ink-soft">جارٍ التحميل...</p>;
  if (!events || events.length === 0) return <p className="text-sm text-ink-soft">لا يوجد أحداث بعد.</p>;

  return (
    <ol className="mt-2 flex flex-col gap-2 border-r border-sand-200 pr-3">
      {events.slice(0, 20).map((event) => (
        <li key={event.id} className="text-xs">
          <span className="font-medium text-ink">{event.eventType}</span>
          <span className="mx-1 text-ink-soft">·</span>
          <span className="text-ink-soft">{new Date(event.occurredAt).toLocaleString('ar-EG')}</span>
        </li>
      ))}
    </ol>
  );
}

export function RuntimeTimelineCard() {
  const { data: devices } = useQuery({ queryKey: DEVICES_QUERY_KEY, queryFn: devicesApi.list });
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);

  if (!devices || devices.length === 0) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">سجل الأحداث الزمني</h2>
      <div className="mt-4 flex flex-col gap-3">
        {devices.map((device) => (
          <div key={device.id}>
            <div className="flex items-center justify-between">
              <p className="text-sm text-ink">جهاز {device.childFirstName}</p>
              <Button
                variant="ghost"
                onClick={() =>
                  setExpandedDeviceId(expandedDeviceId === device.id ? null : device.id)
                }
              >
                {expandedDeviceId === device.id ? 'إخفاء' : 'عرض السجل'}
              </Button>
            </div>
            {expandedDeviceId === device.id && <TimelineList deviceId={device.id} />}
          </div>
        ))}
      </div>
    </Card>
  );
}
