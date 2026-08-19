import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { PendingApprovalsCard } from '@/features/notifications/components/PendingApprovalsCard';
import { ChildrenListCard } from '@/features/children/components/ChildrenListCard';
import { renderWithLocale } from '../growth/renderWithLocale';

/**
 * A2 — ONE ASYNC-STATE COMPONENT, AND THE PROOF THAT IT IS THE ONLY ONE.
 *
 * `AsyncState.tsx` used to live in `features/growth/`. Every card outside
 * growth inlined its own loading line, and most of them had NO error branch:
 * a failed fetch left the data undefined and the card rendered its EMPTY
 * state, so «لا توجد بيانات» was displayed as a fact about the family when
 * the truth was that the request had failed.
 *
 * The two halves below are deliberately different in kind:
 *   - a STATIC sweep, which cannot be satisfied by adding a special case to
 *     one card, and which fails when a NEW card is written the old way;
 *   - a BEHAVIOURAL check on two cards that previously had no error branch
 *     at all, so the sweep cannot pass vacuously against components that
 *     import the boundary and then never render it.
 */

/** Resolved from the vitest root (the package directory), not from a URL —
 * jsdom rewrites `import.meta.url` to a bare path. */
const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The one file allowed to read a list without a state boundary, and why.
 *
 * `PairingCard` reads the children list only to populate a `<select>`; the
 * failure of `GET /children` is reported once, prominently, by
 * `ChildrenListCard` on the same screen. Nine copies of one error banner is
 * not more honest than one — but this list must stay short and each entry
 * must carry a reason, which is what makes it a ratchet rather than a hole.
 */
const NO_BOUNDARY_ALLOWED = ['features/pairing/components/PairingCard.tsx'];

describe('A2 — the four states live in exactly one component', () => {
  const files = walk(SRC).map((f) => relative(SRC, f));

  it('no component re-implements a loading state with the old inline string', () => {
    const offenders = files.filter((f) => {
      const source = readFileSync(join(SRC, f), 'utf8');
      return source.includes("t('common.loading')");
    });
    expect(offenders).toEqual([]);
  });

  it('every component that runs a query routes its states through the shared boundary', () => {
    const offenders = files
      .filter((f) => f.endsWith('.tsx'))
      .filter((f) => readFileSync(join(SRC, f), 'utf8').includes('useQuery('))
      .filter((f) => !readFileSync(join(SRC, f), 'utf8').includes('components/AsyncState'))
      .filter((f) => !NO_BOUNDARY_ALLOWED.includes(f.split('\\').join('/')));

    expect(offenders).toEqual([]);
  });

  it('the boundary is in shared/, not inside one feature', () => {
    // The promotion itself. If it moves back under a feature, every other
    // feature is importing across a boundary again.
    expect(files).toContain('shared/components/AsyncState.tsx');
    expect(files).not.toContain('features/growth/components/AsyncState.tsx');
  });
});

describe('A2 — a failed fetch is no longer indistinguishable from "no data"', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failWith(status: number, body: unknown): void {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  it('PendingApprovalsCard says the request failed instead of disappearing', async () => {
    // Before A2 this card returned `null` on failure — an approval queue that
    // is absent reads as "nothing is waiting for you", which for AI-drafted
    // messages addressed to a child is the worst available wrong answer.
    failWith(500, {
      message: 'Pending approvals query failed.',
      messageAr: 'تعذّر تحميل الرسائل المعلّقة.',
      code: 'PENDING_APPROVALS_FAILED',
      requestId: 'req-a2-001',
    });

    renderWithLocale(<PendingApprovalsCard />, 'ar');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('تعذّر تحميل الرسائل المعلّقة.');
    expect(alert).toHaveTextContent('PENDING_APPROVALS_FAILED');
    expect(alert).toHaveTextContent('req-a2-001');
  });

  it('ChildrenListCard shows the B3 envelope, not a bare "error" line', async () => {
    failWith(503, {
      message: 'Children query failed.',
      messageAr: 'تعذّر تحميل قائمة الأبناء.',
      code: 'CHILDREN_QUERY_FAILED',
      requestId: 'req-a2-002',
    });

    renderWithLocale(<ChildrenListCard />, 'ar');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('تعذّر تحميل قائمة الأبناء.');
    // The empty state must NOT also be on screen — that pairing is the defect.
    expect(screen.queryByText('لا توجد بيانات بعد')).not.toBeInTheDocument();
  });
});
