import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { adminKeyStore } from '@/features/admin-key/adminKeyStore';
import { composePilotStatus } from '@/features/growth/api/adapters';
import { NotificationsPanel } from '@/features/growth/components/NotificationsPanel';
import { PlatformTotalsPanel } from '@/features/growth/components/PlatformTotalsPanel';
import type { GrowthSetting } from '@/features/growth/api/types';
import type { NotificationDecisionAnalytics } from '@/features/growth/api/platformApi';
import { renderWithLocale } from './renderWithLocale';

/**
 * The panels added for the business view, and the two rules they must not
 * break: an unmeasurable number renders NOT MEASURED rather than 0, and a
 * platform-wide total is never presented as a market's.
 */

const RANGE = { from: '2026-07-20', to: '2026-08-18' };

function report(overrides: Partial<NotificationDecisionAnalytics> = {}): NotificationDecisionAnalytics {
  return {
    total: 0,
    decidedSend: 0,
    decidedDefer: 0,
    decidedSuppress: 0,
    delivered: 0,
    outcomeSuppressed: 0,
    duplicates: 0,
    fatigueBlocked: 0,
    deliveryFailures: 0,
    aiRewritten: 0,
    aiFailed: 0,
    opened: 0,
    notificationRows: 0,
    averageScore: 0,
    suppressionRate: 0,
    duplicateRate: 0,
    aiRewriteRate: 0,
    openRate: 0,
    actionRate: null,
    topTypes: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('platform panels', () => {
  beforeEach(() => {
    adminKeyStore.set('test-operator-key');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    adminKeyStore.resetForTests();
  });

  describe('NotificationsPanel', () => {
    it('renders a rate over zero rows as NOT MEASURED, never as a flawless 0%', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(report()));

      renderWithLocale(<NotificationsPanel country="EG" range={RANGE} />, 'ar');

      // The backend sends suppressionRate: 0 for an empty window; the panel
      // refuses to print it as a measurement.
      const suppression = await screen.findByText('نسبة الكبت');
      expect(suppression.parentElement).toHaveTextContent('—');
      expect(suppression.parentElement).not.toHaveTextContent('٠٪');
      expect(screen.getAllByText('لا توجد صفوف في هذه الفترة، فلا نسبة تُحسب.').length).toBeGreaterThan(0);
    });

    it('carries a server-side null action rate through as an absence with its reason', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(report({ total: 40, notificationRows: 30 })));

      renderWithLocale(<NotificationsPanel country="EG" range={RANGE} />, 'ar');

      const actionRate = await screen.findByText('نسبة التفاعل');
      expect(actionRate.parentElement).toHaveTextContent('—');
      expect(
        screen.getByText('غير قابلة للقياس اليوم: لا يوجد ربط عميق ولا إيصال إجراء داخل التطبيق.'),
      ).toBeInTheDocument();
    });

    it('prints real rates once there are rows to compute them from', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        jsonResponse(report({ total: 200, notificationRows: 160, delivered: 150, suppressionRate: 0.25 })),
      );

      renderWithLocale(<NotificationsPanel country="EG" range={RANGE} />, 'en');

      const suppression = await screen.findByText('Suppression rate');
      expect(suppression.parentElement).toHaveTextContent('25.0%');
    });

    it('scopes the request to one market and names the endpoint it read', async () => {
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(report({ total: 5 })));

      // `rangeFor` produces full ISO instants — exactly what this route rejects.
      renderWithLocale(
        <NotificationsPanel
          country="SA"
          range={{ from: '2026-07-20T09:31:04.000Z', to: '2026-08-18T09:31:04.000Z' }}
        />,
        'ar',
      );
      await screen.findByText('GET /system/notifications/analytics');

      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('country=SA');
      // This route runs `isBusinessDate` and rejects a full ISO instant with
      // a 400 — the client narrows the shared range to YYYY-MM-DD.
      expect(url).toContain('from=2026-07-20');
      expect(url).toContain('to=2026-08-18');
      expect(url).not.toContain('T00');
    });
  });

  describe('PlatformTotalsPanel', () => {
    it('states that its figures are not one market’s, and never shows the backend’s zeroed trial rate', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        jsonResponse({
          totalFamilies: 1240,
          activeFamiliesLast7Days: 810,
          totalDevices: 1900,
          activeDevicesLast7Days: 1100,
          // The backend turns "no trial has resolved yet" into 0 here. It
          // must not reach the screen.
          trialConversionRate: 0,
          supportRequestCountLast7Days: 12,
        }),
      );

      renderWithLocale(<PlatformTotalsPanel />, 'en');

      expect(await screen.findByText('Registered families')).toBeInTheDocument();
      expect(
        screen.getByText(
          "These figures cover both markets together. Do not read them as Egypt's or Saudi Arabia's.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/trial conversion/i)).not.toBeInTheDocument();
    });

    it('declares the per-country split as a missing endpoint instead of dividing the total', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        jsonResponse({
          totalFamilies: 1240,
          activeFamiliesLast7Days: 810,
          totalDevices: 1900,
          activeDevicesLast7Days: 1100,
          trialConversionRate: 0,
          supportRequestCountLast7Days: 12,
        }),
      );

      renderWithLocale(<PlatformTotalsPanel />, 'en');

      expect(
        await screen.findByText('GET /admin/growth/families?countryCode&asOf → { registered, active }'),
      ).toBeInTheDocument();
      expect(screen.getByText('KPI `ACTIVE_PARENTS` in GET /admin/growth/kpis')).toBeInTheDocument();
    });
  });

  describe('composePilotStatus', () => {
    const settings = (value: string): GrowthSetting[] => [
      { key: 'pilot.enabled', value: true, isDefault: false, type: 'BOOL', humanDecision: true },
      { key: 'pilot.countries', value, isDefault: false, type: 'STRING', humanDecision: true },
      { key: 'pilot.cohortId', value: 'cohort-a', isDefault: false, type: 'STRING', humanDecision: true },
    ];

    it('parses the country list exactly as the registration gate does', () => {
      const status = composePilotStatus(settings(' sa , eg ,'), 'SA').data;
      expect(status.enabled).toBe(true);
      expect(status.inPilot).toBe(true);
      expect(composePilotStatus(settings('SA'), 'EG').data.inPilot).toBe(false);
    });

    it('reports an unset row as UNKNOWN rather than as "off"', () => {
      const status = composePilotStatus([], 'EG').data;
      expect(status.enabled).toBeNull();
      expect(status.inPilot).toBeNull();
      expect(status.cohortConfigured).toBeNull();
    });

    it('never carries the cohort id off the wire — an operator screen shows no database ids', () => {
      const status = composePilotStatus(settings('EG'), 'EG').data;
      expect(JSON.stringify(status)).not.toContain('cohort-a');
      expect(status.cohortConfigured).toBe(true);
    });

    it('names the endpoint it was composed from', () => {
      expect(composePilotStatus([], 'EG').composedFrom).toEqual(['GET /admin/growth/settings']);
    });
  });
});
