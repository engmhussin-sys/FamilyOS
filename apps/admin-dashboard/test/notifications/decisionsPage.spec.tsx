import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { adminKeyStore } from '@/features/admin-key/adminKeyStore';
import { NotificationDecisionsPage } from '@/features/notifications/pages/NotificationDecisionsPage';
import type {
  DecisionBreakdown,
  DecisionBucket,
} from '@/features/notifications/api/decisionBreakdownApi';
import { ApiError } from '@/shared/lib/httpClient';
import { renderWithLocale } from '../growth/renderWithLocale';

/**
 * THE OPERATOR DECISION PAGE, IN ITS FOUR STATES AND ITS ONE RULE.
 *
 * The rule this file exists for: a number this dashboard does not have renders
 * as «غير مُقاس», never as a zero. The page has exactly one honest instance of
 * it — the tail of a list the server truncated at its top-N cap — and the tail
 * is precisely the number a well-meaning `?? 0` would invent.
 *
 * The locale engine used here is the REAL one with the REAL ar.json, so every
 * Arabic assertion below also proves its key exists: a missing key renders as
 * the raw key string and the assertion fails.
 */

function bucket(name: string, overrides: Partial<DecisionBucket> = {}): DecisionBucket {
  return {
    bucket: name,
    total: 0,
    decidedSend: 0,
    decidedDefer: 0,
    decidedSuppress: 0,
    delivered: 0,
    deliveryErrors: 0,
    ...overrides,
  };
}

function report(overrides: Partial<DecisionBreakdown> = {}): DecisionBreakdown {
  return {
    fromBusinessDate: '2025-11-20',
    toBusinessDate: '2025-11-21',
    totals: bucket('ALL', {
      total: 4,
      decidedSend: 2,
      decidedDefer: 1,
      decidedSuppress: 1,
      delivered: 1,
      deliveryErrors: 1,
    }),
    byAudience: [
      bucket('PARENT', { total: 3, decidedSend: 2, decidedDefer: 1, delivered: 1, deliveryErrors: 1 }),
      bucket('CHILD', { total: 1, decidedSuppress: 1 }),
    ],
    byNotificationType: [bucket('REWARD_GRANTED', { total: 3, decidedSend: 2, decidedDefer: 1 })],
    bySource: [
      bucket('DOMAIN_EVENT', { total: 3, decidedSend: 2, decidedDefer: 1 }),
      bucket('PERIODIC_SIGNAL', { total: 1, decidedSuppress: 1 }),
    ],
    byProvenance: [bucket('rule-based', { total: 4, decidedSend: 2 })],
    byDate: [bucket('2025-11-20', { total: 2 }), bucket('2025-11-21', { total: 2 })],
    topCauses: [bucket('REWARD_GRANTED', { total: 3 }), bucket('HYDRATION_REMINDER', { total: 1 })],
    limits: { topLimit: 20, maxRangeDays: 92, typesTruncated: false, causesTruncated: false },
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('the notification decision page', () => {
  beforeEach(() => {
    // The page sits behind `AdminKeyGate` in the router; rendered directly it
    // still goes through `adminHttp`, which refuses to fire without a key.
    adminKeyStore.set('test-operator-key');
    vi.restoreAllMocks();
  });

  // Reset in `beforeEach` only: an `afterEach` reset publishes to a component
  // Testing Library has not unmounted yet, and the update lands outside
  // `act()`.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  describe('loading', () => {
    it('announces loading with a skeleton that contains no digits', async () => {
      // A pending fetch that never resolves — the state an operator on a slow
      // link actually sees, rather than a synchronous stub.
      vi.spyOn(global, 'fetch').mockReturnValue(new Promise<Response>(() => undefined));

      const { container } = renderWithLocale(<NotificationDecisionsPage />, 'ar');

      const status = await screen.findByRole('status');
      expect(status).toHaveAttribute('aria-busy', 'true');
      expect(status).toHaveTextContent('جارٍ تحميل البيانات…');
      // THE POINT OF A SKELETON. A placeholder that reads as a measurement is
      // the bug it exists to prevent, so no digit may appear inside it.
      expect(status.textContent).not.toMatch(/[0-9٠-٩]/);
      // And the page chrome is already there, so the layout does not jump.
      expect(container.textContent).toContain('سجلّ قرارات الإشعارات');
    });
  });

  // ==========================================================================
  describe('empty', () => {
    it('a window with no decisions says so, and denies being a zero', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async () =>
        jsonResponse(report({ totals: bucket('ALL'), byAudience: [], byDate: [], topCauses: [] })),
      );

      renderWithLocale(<NotificationDecisionsPage />, 'ar');

      expect(await screen.findByText('لا توجد بيانات بعد')).toBeInTheDocument();
      expect(
        screen.getByText('لم يُسجَّل أي قرار إشعار في هذه الفترة. هذا ليس صفرًا.'),
      ).toBeInTheDocument();
      // No stat tile is rendered at all in this state — an empty window must
      // not produce six confident zeros.
      expect(screen.queryByText('الإجمالي')).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  describe('error', () => {
    it('shows the backend’s Arabic message and the request id, not a blank panel', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(
        new ApiError(
          'Decision breakdown failed.',
          500,
          'DECISION_BREAKDOWN_FAILED',
          'تعذّر تحميل سجلّ القرارات.',
          'req-brk-77',
        ),
      );

      renderWithLocale(<NotificationDecisionsPage />, 'ar');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('تعذّر تحميل سجلّ القرارات.');
      expect(alert).toHaveTextContent('DECISION_BREAKDOWN_FAILED');
      expect(alert).toHaveTextContent('req-brk-77');
      // Nothing numeric survives an error — a half-rendered table beside a red
      // banner is how a stale number gets read as a current one.
      expect(screen.queryByText('الإجمالي')).not.toBeInTheDocument();
    });

    it('offers a retry that refires the request', async () => {
      const user = userEvent.setup();
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('Failed to fetch'))
        .mockRejectedValueOnce(new Error('Failed to fetch'));

      renderWithLocale(<NotificationDecisionsPage />, 'ar');

      await screen.findByRole('alert');
      const callsBefore = fetchSpy.mock.calls.length;
      await user.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
      await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore));
    });
  });

  // ==========================================================================
  describe('the numbers', () => {
    it('renders the totals and every one of the six slices', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async () => jsonResponse(report()));

      renderWithLocale(<NotificationDecisionsPage />, 'ar');

      expect(await screen.findByText('حسب الجمهور')).toBeInTheDocument();
      expect(screen.getByText('حسب المصدر')).toBeInTheDocument();
      expect(screen.getByText('حسب المُقرِّر')).toBeInTheDocument();
      expect(screen.getByText('حسب اليوم')).toBeInTheDocument();
      expect(screen.getByText('حسب نوع الإشعار')).toBeInTheDocument();
      expect(screen.getByText('أبرز الأسباب')).toBeInTheDocument();

      // Bucket names are the backend's own tokens, rendered verbatim and LTR
      // so an operator can grep for exactly what they see.
      const parent = screen.getByText('PARENT');
      expect(parent).toHaveAttribute('dir', 'ltr');
      expect(screen.getByText('PERIODIC_SIGNAL')).toBeInTheDocument();
      expect(screen.getByText('rule-based')).toBeInTheDocument();
      expect(screen.getByText('HYDRATION_REMINDER')).toBeInTheDocument();
    });

    it('prints the window the SERVER resolved, not the one the page asked for', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async () => jsonResponse(report()));

      renderWithLocale(<NotificationDecisionsPage />, 'ar');

      expect(await screen.findByText('2025-11-20 → 2025-11-21')).toBeInTheDocument();
    });

    it('never renders a family, a child or a message — it cannot, and it asks for nothing that would', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => jsonResponse(report()));

      const { container } = renderWithLocale(<NotificationDecisionsPage />, 'ar');
      await screen.findByText('حسب الجمهور');

      const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      expect(container.textContent ?? '').not.toMatch(uuid);
      // And the request itself carries no family or child parameter.
      const url = String(fetchSpy.mock.calls[0]?.[0] ?? '');
      expect(url).toContain('/system/notifications/decision-breakdown');
      expect(url).not.toMatch(/family|child/i);
    });

    it('sends the audience filter as an absence, never as the literal ALL', async () => {
      const user = userEvent.setup();
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => jsonResponse(report()));

      renderWithLocale(<NotificationDecisionsPage />, 'ar');
      await screen.findByText('حسب الجمهور');

      // The route validates `audience` against PARENT|CHILD and answers 400 to
      // anything else, so "no filter" must be the parameter's ABSENCE.
      expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('audience=');

      await user.click(screen.getByRole('button', { name: 'وليّ الأمر' }));
      await waitFor(() =>
        expect(
          fetchSpy.mock.calls.some((call) => String(call[0]).includes('audience=PARENT')),
        ).toBe(true),
      );
    });
  });

  // ==========================================================================
  describe('what cannot be measured', () => {
    it('renders the truncated tail as «غير مُقاس», never as 0', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async () =>
        jsonResponse(
          report({
            limits: {
              topLimit: 20,
              maxRangeDays: 92,
              typesTruncated: true,
              causesTruncated: true,
            },
          }),
        ),
      );

      const { container } = renderWithLocale(<NotificationDecisionsPage />, 'ar');

      // One remainder row per truncated list, six cells each.
      const unmeasured = await screen.findAllByText('غير مُقاس');
      expect(unmeasured).toHaveLength(12);

      // THE ASSERTION THAT MATTERS. The tail was never counted, so no cell of
      // the remainder row may carry a digit — a `?? 0` here would report that
      // the untruncated types sent nothing, which is a claim nobody measured.
      const remainderRows = Array.from(container.querySelectorAll('tr')).filter((row) =>
        row.textContent?.includes('بقيّة الصفوف'),
      );
      expect(remainderRows).toHaveLength(2);
      for (const row of remainderRows) {
        expect(row.textContent ?? '').not.toMatch(/[0-9٠-٩]/);
      }

      // And the absence carries its reason, so it cannot be mistaken for a
      // rendering fault.
      expect(unmeasured[0].closest('span')?.parentElement).toHaveAttribute(
        'title',
        expect.stringContaining('20'),
      );
    });

    it('shows no remainder row at all when nothing was truncated', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async () => jsonResponse(report()));

      renderWithLocale(<NotificationDecisionsPage />, 'ar');
      await screen.findByText('حسب الجمهور');

      // A complete list has no unmeasured tail — inventing an "other: 0" row
      // would be the same lie in the other direction.
      expect(screen.queryByText('غير مُقاس')).not.toBeInTheDocument();
      expect(screen.queryByText('بقيّة الصفوف')).not.toBeInTheDocument();
    });

    it('a slice that is genuinely empty says so rather than showing an empty table', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async () => jsonResponse(report({ byProvenance: [] })));

      renderWithLocale(<NotificationDecisionsPage />, 'ar');

      expect(
        await screen.findByText('لا توجد صفوف في هذا التقسيم ضمن الفترة والمرشّح الحاليين.'),
      ).toBeInTheDocument();
    });

    it('a real zero count is still printed as a zero — the rule is about the UNMEASURED, not the small', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async () => jsonResponse(report()));

      renderWithLocale(<NotificationDecisionsPage />, 'ar');
      await screen.findByText('حسب الجمهور');

      // `CHILD` really did have 0 delivered: it was counted and the answer was
      // zero. Blanking that would be the opposite failure — hiding a measured
      // fact behind an absence.
      const childRow = screen.getByText('CHILD').closest('tr');
      expect(childRow?.textContent).toMatch(/[0٠]/);
    });
  });
});
