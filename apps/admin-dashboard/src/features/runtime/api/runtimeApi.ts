import { httpClient } from '../../../shared/lib/httpClient';

export interface TimelineEvent {
  id: string;
  eventType: string;
  fromState: string | null;
  toState: string;
  actorType: string;
  occurredAt: string;
}

export const timelineQueryKey = (deviceId: string) => ['device-timeline', deviceId] as const;

export const runtimeApi = {
  getTimeline(deviceId: string): Promise<TimelineEvent[]> {
    return httpClient<TimelineEvent[]>(`/pairing/device/${deviceId}/timeline`);
  },

  getAlerts(): Promise<RuntimeAlert[]> {
    return httpClient<RuntimeAlert[]>('/pairing/alerts');
  },
};

export interface RuntimeAlert {
  id: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export const ALERTS_QUERY_KEY = ['runtime-alerts'] as const;
