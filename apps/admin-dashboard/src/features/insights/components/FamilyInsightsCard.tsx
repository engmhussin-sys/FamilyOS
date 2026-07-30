import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { devicesApi, DEVICES_QUERY_KEY } from '../../devices/api/devicesApi';
import { insightsApi, insightsQueryKey, decisionHistoryQueryKey } from '../api/insightsApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';

function DeviceInsightsPanel({ childId, deviceId }: { childId: string; deviceId: string }) {
  const [showHistory, setShowHistory] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);

  const { data: insights, isLoading } = useQuery({
    queryKey: insightsQueryKey(childId, deviceId),
    queryFn: () => insightsApi.getInsights(childId, deviceId),
  });

  const { data: history } = useQuery({
    queryKey: decisionHistoryQueryKey(childId),
    queryFn: () => insightsApi.getDecisionHistory(childId),
    enabled: showHistory,
  });

  if (isLoading) return <p className="text-sm text-ink-soft">جارٍ التحليل...</p>;
  if (!insights) return null;

  return (
    <div className="rounded-card border border-sand-200 p-3">
      <p className="text-sm font-medium text-ink">{insights.recommendation.title}</p>
      <p className="text-xs text-ink-soft">{insights.recommendation.body}</p>
      <p className="mt-1 text-xs text-ink-soft">
        الثقة: {Math.round(insights.recommendation.decision.confidence * 100)}% ·{' '}
        {insights.behavioralTrend.summary}
      </p>

      <div className="mt-2 flex gap-2">
        <Button variant="ghost" onClick={() => setShowReasoning((v) => !v)}>
          {showReasoning ? 'إخفاء التفسير' : 'لماذا هذه التوصية؟'}
        </Button>
        <Button variant="ghost" onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? 'إخفاء السجل' : 'سجل القرارات'}
        </Button>
      </div>

      {showReasoning && (
        <ul className="mt-2 list-disc pr-4 text-xs text-ink-soft">
          {insights.recommendation.decision.reasoningPath.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}

      {showHistory && history && (
        <ol className="mt-2 flex flex-col gap-1 border-r border-sand-200 pr-3 text-xs">
          {history.map((entry) => (
            <li key={entry.id}>
              <span className="font-medium text-ink">{entry.value.title}</span>
              <span className="mx-1 text-ink-soft">·</span>
              <span className="text-ink-soft">
                {new Date(entry.createdAt).toLocaleDateString('ar-EG')}
              </span>
            </li>
          ))}
          {history.length === 0 && <li className="text-ink-soft">لا يوجد قرارات سابقة.</li>}
        </ol>
      )}
    </div>
  );
}

export function FamilyInsightsCard() {
  const { data: devices } = useQuery({ queryKey: DEVICES_QUERY_KEY, queryFn: devicesApi.list });

  if (!devices || devices.length === 0) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">رؤى العائلة (بالذكاء الاصطناعي الداخلي)</h2>
      <div className="mt-4 flex flex-col gap-3">
        {devices.map((device) => (
          <DeviceInsightsPanel key={device.id} childId={device.childId} deviceId={device.id} />
        ))}
      </div>
    </Card>
  );
}
