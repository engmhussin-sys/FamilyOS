import { useQuery } from '@tanstack/react-query';
import { runtimeApi, ALERTS_QUERY_KEY } from '../api/runtimeApi';
import { Card } from '../../../shared/components/Card';

export function AlertCenterCard() {
  const { data: alerts, isLoading } = useQuery({
    queryKey: ALERTS_QUERY_KEY,
    queryFn: runtimeApi.getAlerts,
  });

  if (isLoading) return null;
  if (!alerts || alerts.length === 0) return null;

  return (
    <Card className="border-brick-200 bg-brick-50">
      <h2 className="font-display text-lg text-ink">تنبيهات الحماية</h2>
      <div className="mt-3 flex flex-col gap-2">
        {alerts.slice(0, 10).map((alert) => (
          <div key={alert.id} className="rounded-card bg-white px-3 py-2">
            <p className="text-sm font-medium text-ink">{alert.title}</p>
            <p className="text-xs text-ink-soft">{alert.body}</p>
            <p className="mt-1 text-xs text-ink-soft">
              {new Date(alert.createdAt).toLocaleString('ar-EG')}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}
