import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithLocale } from '../growth/renderWithLocale';

/**
 * ===========================================================================
 * THE FOUR SCREENS, JUDGED ON WHAT THEY REFUSE TO SAY.
 * ===========================================================================
 *
 * These pages call endpoints that already existed, so «does it fetch» is not
 * an interesting claim. What is interesting — and what a dashboard over
 * production infrastructure gets wrong — is the set of moments where a screen
 * is tempted to round an ambiguous backend answer up into a reassuring one:
 *
 *   A manual job run that returns `claimed: false` DID NOTHING. Another replica
 *   held the lease. Rendering that as "ran successfully" would tell an operator
 *   the sweep they just forced had swept.
 *
 *   A truncated sweep is recorded FAILED by the backend, because a partial
 *   fan-out that reports green is the defect the field exists to prevent.
 *
 *   A `dead: 0` on the notification backlog does NOT mean every notification
 *   arrived — the immediate push path discards its outcome entirely. The caveat
 *   has to be ABOVE the number, because a caveat under a green zero is a caveat
 *   nobody reads.
 *
 *   An AI cost figure counts SUCCESSES ONLY, and has no household attribution
 *   to give, because the writer omits the family id.
 *
 * Every one of those is asserted below as a REFUSAL, not as a rendering.
 */

const jobsApi = {
  list: vi.fn(),
  runs: vi.fn(),
  failures: vi.fn(),
  run: vi.fn(),
  setEnabled: vi.fn(),
};
const outboxApi = { deadLetters: vi.fn(), recover: vi.fn() };
const deliveriesApi = { backlog: vi.fn() };
const aiUsageApi = { summary: vi.fn() };

vi.mock('@/features/platform/api/platformRuntimeApi', () => ({
  jobsApi,
  outboxApi,
  deliveriesApi,
  aiUsageApi,
}));

const { JobsPage } = await import('@/features/platform/pages/JobsPage');
const { OutboxPage } = await import('@/features/platform/pages/OutboxPage');
const { DeliveriesPage } = await import('@/features/platform/pages/DeliveriesPage');
const { AiUsagePage } = await import('@/features/platform/pages/AiUsagePage');

const JOB = {
  name: 'data-retention-sweep',
  scope: 'PLATFORM' as const,
  cadenceSeconds: 86_400,
  localHour: null,
  enabled: true,
  nextRunAt: '2026-08-22T02:00:00.000Z',
  lastStartedAt: '2026-08-21T02:00:00.000Z',
  lastFinishedAt: '2026-08-21T02:00:12.000Z',
  lastStatus: 'SUCCEEDED',
  lastError: null,
  lastDurationMs: 12_000,
  lastAffectedRows: 412,
  consecutiveFailures: 0,
  lockedBy: null,
  lockedAt: null,
  description: 'كنس الاحتفاظ بالبيانات',
  registered: true,
  alerting: false,
  running: false,
};

/** A `scheduled_jobs` row that no code answers to. It can never run. */
const ORPHAN_JOB = {
  ...JOB,
  name: 'goal-nudge-sweep',
  registered: false,
  lastFinishedAt: null,
  lastStatus: null,
  description: 'تنبيهات الأهداف',
};

beforeEach(() => {
  vi.clearAllMocks();
  jobsApi.list.mockResolvedValue({ jobs: [JOB, ORPHAN_JOB], alerting: 0, disabled: 0 });
  jobsApi.runs.mockResolvedValue({ runs: [], count: 0 });
  jobsApi.failures.mockResolvedValue({ windowHours: 24, failures: [], total: 0 });
});

describe('the scheduled-jobs screen', () => {
  it('J1 — a job with no handler is an ALERT, and cannot be run', async () => {
    renderWithLocale(<JobsPage />);

    // Not a column value, not a grey badge: a row that can never run is a
    // finding, and nothing else in this system says so.
    expect(await screen.findByText(/بلا مُنفّذ/)).toBeInTheDocument();
    expect(screen.getByText(/بلا مُنفّذ/)).toHaveAttribute('role', 'alert');

    const runButtons = screen.getAllByRole('button', { name: 'شغّل الآن' });
    // Two jobs, two buttons; the orphan's is the disabled one.
    expect(runButtons).toHaveLength(2);
    expect(runButtons[1]).toBeDisabled();
    expect(runButtons[0]).toBeEnabled();
  });

  it('J2 — a job that never ran says so, rather than rendering a blank cell', async () => {
    renderWithLocale(<JobsPage />);

    // A blank reads as a formatting problem. "Never ran" is the measurement.
    expect(await screen.findByText('لم تعمل قطّ')).toBeInTheDocument();
  });

  it('J3 — nothing is triggered until the dialog is confirmed, and cancel fires nothing', async () => {
    const user = userEvent.setup();
    renderWithLocale(<JobsPage />);

    await user.click((await screen.findAllByRole('button', { name: 'شغّل الآن' }))[0]);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // The blast radius is written out — not "are you sure".
    expect(dialog).toHaveTextContent(/تحذف صفوفًا عبر كل الأسر/);
    expect(jobsApi.run).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(jobsApi.run).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('J4 — a run that took no lease reads as NOTHING HAPPENED, never as success', async () => {
    const user = userEvent.setup();
    jobsApi.run.mockResolvedValue({
      job: 'data-retention-sweep',
      claimed: false,
      executed: 0,
      skipped: 0,
      failed: 0,
      affectedRows: 0,
      durationMs: 0,
      familiesSeen: 0,
      pages: 0,
      truncated: false,
    });

    renderWithLocale(<JobsPage />);
    await user.click((await screen.findAllByRole('button', { name: 'شغّل الآن' }))[0]);
    // Scoped to the dialog: the row button and the confirm button share a
    // label on purpose — the confirmation names the action rather than saying
    // "OK", so the test has to say which one it presses.
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'شغّل الآن' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/لم يعمل شيء/);
    expect(status).not.toHaveTextContent(/عمل:/);
  });

  it('J5 — a truncated sweep reads as a failure, not as a big number', async () => {
    const user = userEvent.setup();
    jobsApi.run.mockResolvedValue({
      job: 'family-daily-rollover',
      claimed: true,
      executed: 100_000,
      skipped: 0,
      failed: 0,
      affectedRows: 100_000,
      durationMs: 900,
      familiesSeen: 100_000,
      pages: 500,
      truncated: true,
    });

    renderWithLocale(<JobsPage />);
    await user.click((await screen.findAllByRole('button', { name: 'شغّل الآن' }))[0]);
    // Scoped to the dialog: the row button and the confirm button share a
    // label on purpose — the confirmation names the action rather than saying
    // "OK", so the test has to say which one it presses.
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'شغّل الآن' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/التوزيع الجزئي ليس نجاحًا/);
    // The impressive count must not be the headline of a failed run.
    expect(status).not.toHaveTextContent('100000');
  });

  it('J6 — disabling is a DESTRUCTIVE dialog and focus lands on cancel, not on it', async () => {
    const user = userEvent.setup();
    renderWithLocale(<JobsPage />);

    await user.click((await screen.findAllByRole('button', { name: 'تعطيل' }))[0]);

    const cancel = await screen.findByRole('button', { name: 'إلغاء' });
    // A stray Enter on an operator console must be a no-op, never a kill switch.
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(jobsApi.setEnabled).not.toHaveBeenCalled();
  });

  it('J7 — Escape closes the dialog without acting', async () => {
    const user = userEvent.setup();
    renderWithLocale(<JobsPage />);

    await user.click((await screen.findAllByRole('button', { name: 'شغّل الآن' }))[0]);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(jobsApi.run).not.toHaveBeenCalled();
  });
});

describe('the outbox screen', () => {
  const report = (dead: number, pending: number) => ({
    deadLetters: {
      total: dead,
      byEventType: dead
        ? [{ eventType: 'REWARD_GRANTED', count: dead, oldestAgeSeconds: 7200, familyCount: 3 }]
        : [],
      messages: dead
        ? [
            {
              id: 'm1',
              familyId: 'f1',
              domainEventId: 'e1',
              eventType: 'REWARD_GRANTED',
              attemptCount: 8,
              lastError: 'ECONNREFUSED',
              createdAt: '2026-08-20T10:00:00.000Z',
            },
          ]
        : [],
    },
    backlog: { ageSeconds: 3600, pendingCount: pending, familyCount: 2 },
  });

  it('O1 — the same dead count reads differently depending on the pending count beside it', async () => {
    outboxApi.deadLetters.mockResolvedValue(report(12, 4000));
    const stalled = renderWithLocale(<OutboxPage />);
    expect(await screen.findByText(/توقّف في المُرحّل/)).toBeInTheDocument();
    stalled.unmount();

    outboxApi.deadLetters.mockResolvedValue(report(12, 0));
    renderWithLocale(<OutboxPage />);
    expect(await screen.findByText(/رسائل بعينها تفشل في كل مرة/)).toBeInTheDocument();
  });

  it('O2 — recovery is confirmed first, and the dialog states that it is safe to repeat', async () => {
    const user = userEvent.setup();
    outboxApi.deadLetters.mockResolvedValue(report(12, 0));
    outboxApi.recover.mockResolvedValue({ recovered: 12, remaining: 0 });

    renderWithLocale(<OutboxPage />);
    await user.click(await screen.findByRole('button', { name: 'أعدها إلى المعلّق' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/آمن أن تضغطه مرتين/);
    expect(outboxApi.recover).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole('button', { name: 'أعدها إلى المعلّق' }).at(-1)!);
    await waitFor(() => expect(outboxApi.recover).toHaveBeenCalledWith({ eventType: 'REWARD_GRANTED' }));
  });

  it('O3 — the real provider error is shown, not a summary of it', async () => {
    outboxApi.deadLetters.mockResolvedValue(report(1, 0));
    renderWithLocale(<OutboxPage />);

    expect(await screen.findByText('ECONNREFUSED')).toBeInTheDocument();
  });
});

describe('the notification-backlog screen', () => {
  beforeEach(() => {
    deliveriesApi.backlog.mockResolvedValue({
      pending: 4,
      dead: 0,
      oldestPendingAgeSeconds: 7200,
      deadByType: [],
    });
  });

  it('D1 — the scope caveat is rendered ABOVE the numbers it qualifies', async () => {
    const { container } = renderWithLocale(<DeliveriesPage />);

    const caveat = await screen.findByRole('note');
    expect(caveat).toHaveTextContent(/المسار المؤجّل فقط/);
    // A caveat placed under a green zero is a caveat nobody reads. DOM order is
    // the claim, so DOM order is what is asserted.
    const gauges = await screen.findByText('معلّق');
    expect(caveat.compareDocumentPosition(gauges) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it('D2 — a dead count of zero is never presented as "everything arrived"', async () => {
    renderWithLocale(<DeliveriesPage />);
    await screen.findByRole('note');

    expect(screen.getByRole('note')).toHaveTextContent(/لا يعني أن كل إشعار وصل/);
  });

  it('D3 — the two things it cannot measure are DECLARED, with the endpoint that would fix them', async () => {
    renderWithLocale(<DeliveriesPage />);

    expect(await screen.findByText(/لا يوجد مسار مشغّل لإشعار واحد/)).toBeInTheDocument();
    expect(screen.getByText(/المسار الفوري لا يثبّت نتيجته/)).toBeInTheDocument();
    // Written as a contract, LTR inside an RTL page, so it is copy-pasteable.
    const proposed = screen.getAllByText(/POST \.\.\.\/retry/);
    expect(proposed.length).toBeGreaterThan(0);
    expect(proposed[0].closest('code')).toHaveAttribute('dir', 'ltr');
  });
});

describe('the AI cost screen', () => {
  beforeEach(() => {
    aiUsageApi.summary.mockResolvedValue({
      windowDays: 30,
      totalCalls: 120,
      totalInputTokens: 45_000,
      totalOutputTokens: 9_000,
      totalCostUsd: 0.4231,
      byFeature: { unattributed: { calls: 120, costUsd: 0.4231 } },
    });
  });

  it('A1 — every money figure is labelled ESTIMATED, because it is a token count times a constant', async () => {
    renderWithLocale(<AiUsagePage />);

    expect((await screen.findAllByText('التكلفة التقديرية (دولار)')).length).toBeGreaterThan(0);
    // Twice: once as the total, once on the per-feature row. Both carry the
    // same four decimals, because both are the same estimate.
    expect(screen.getAllByText('$0.4231')).toHaveLength(2);
  });

  it('A2 — it refuses to imply per-household attribution or total spend', async () => {
    renderWithLocale(<AiUsagePage />);

    expect(await screen.findByText(/لا يمكن نسبة أي رقم هنا إلى أسرة/)).toBeInTheDocument();
    expect(screen.getByText(/هذا ما كلّفه الناجح/)).toBeInTheDocument();
  });

  it('A3 — changing the window re-asks the backend rather than re-slicing on the client', async () => {
    const user = userEvent.setup();
    renderWithLocale(<AiUsagePage />);
    await screen.findAllByText('$0.4231');

    await user.click(screen.getByRole('radio', { name: '7 يومًا' }));

    await waitFor(() => expect(aiUsageApi.summary).toHaveBeenCalledWith(7));
  });
});
