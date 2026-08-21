import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MemoryRouter } from 'react-router-dom';

import { renderWithLocale } from '../growth/renderWithLocale';
import { ApiError } from '@/shared/lib/httpClient';

/**
 * ===========================================================================
 * THE TIER GRANT — the route that was built, guarded, audited and unreachable.
 * ===========================================================================
 *
 * `POST /system/billing/grants` comps a whole tier by reading
 * `plan_definitions`. It has been behind the operator key since the console
 * landed and no button in this dashboard has ever called it; the only wired
 * grant was the by-feature one, which was added precisely BECAUSE the tier
 * route refuses on an empty catalogue.
 *
 * That refusal is the interesting part, and it is why the two grants are
 * offered side by side rather than one replacing the other:
 *
 *   BY FEATURE works on any database, including one whose catalogue is empty —
 *   which is every database built from this repository's migrations.
 *   BY TIER follows the catalogue, so editing PREMIUM later moves every comp
 *   with it. That is the right grant once the catalogue is filled in.
 *
 * `PLAN_CATALOGUE_EMPTY` therefore has to reach the operator AS ITSELF. A
 * generic red box would leave them pressing the same button; the platform has
 * not decided what the tier includes, and the remedy is a different screen.
 */

const platformAccountsApi = {
  list: vi.fn(),
  entitlements: vi.fn(),
  grantFeatures: vi.fn(),
  grantPlan: vi.fn(),
  revoke: vi.fn(),
};
const householdApi = { detail: vi.fn(), setStatus: vi.fn() };

vi.mock('@/features/platform/api/platformAccountsApi', async () => {
  const actual = await vi.importActual<typeof import('@/features/platform/api/platformAccountsApi')>(
    '@/features/platform/api/platformAccountsApi',
  );
  return { ...actual, platformAccountsApi, householdApi };
});

const { AccountsPage } = await import('@/features/platform/pages/AccountsPage');

const ROW = {
  familyId: '11111111-1111-4111-8111-111111111111',
  familyName: 'أسرة التجربة',
  countryCode: 'EG',
  createdAt: '2026-06-01T00:00:00.000Z',
  ownerEmail: 'owner@example.com',
  ownerStatus: 'ACTIVE',
  memberCount: 2,
  childCount: 1,
  deviceCount: 1,
  subscriptionStatus: 'ACTIVE',
  planTier: 'FREE',
  lastSeenAt: '2026-08-20T00:00:00.000Z',
  hasLiveEntitlement: false,
};

/**
 * Returns the panel as well as the user, and every query below is scoped to
 * it. The household DETAIL panel renders above the grant panel and has its own
 * «reason» field for suspension — an unscoped `getByLabelText('السبب')` finds
 * both, and a test that silently typed a comp's justification into the
 * suspension box would still have passed.
 */
async function openPanel() {
  const user = userEvent.setup();
  // A router, because the empty-catalogue refusal renders a <Link> to the
  // catalogue screen — the remedy is a different page, so the panel has to be
  // able to point at it.
  renderWithLocale(
    <MemoryRouter>
      <AccountsPage />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'إدارة الباقة' }));
  const panel = await screen.findByRole('complementary', { name: 'ترقية يدوية بلا اشتراك' });
  return { user, panel };
}

beforeEach(() => {
  vi.clearAllMocks();
  platformAccountsApi.list.mockResolvedValue({ rows: [ROW], nextCursor: null });
  platformAccountsApi.entitlements.mockResolvedValue({
    familyId: ROW.familyId,
    features: [],
    validUntil: null,
    planTier: 'FREE',
  });
  householdApi.detail.mockResolvedValue({
    familyId: ROW.familyId,
    familyName: ROW.familyName,
    countryCode: 'EG',
    timezone: 'Africa/Cairo',
    createdAt: ROW.createdAt,
    members: [],
    children: [],
    devices: [],
    subscription: null,
    entitlements: [],
    audit: [],
  });
});

describe('the grant panel', () => {
  it('G1 — offers both grants, and says which one survives an empty catalogue', async () => {
    const { panel } = await openPanel();

    expect(within(panel).getByRole('radio', { name: 'مزايا مُسمّاة' })).toBeChecked();
    expect(within(panel).getByRole('radio', { name: 'باقة كاملة' })).not.toBeChecked();
    expect(within(panel).getByText(/يعمل على أي قاعدة بيانات/)).toBeInTheDocument();
  });

  it('G2 — the tier grant calls the route that had no caller, not the feature route', async () => {
    const { user, panel } = await openPanel();
    platformAccountsApi.grantPlan.mockResolvedValue({
      familyId: ROW.familyId,
      planTier: 'PREMIUM',
      validUntil: '2026-09-20T00:00:00.000Z',
      features: ['multiple_children'],
    });

    await user.click(within(panel).getByRole('radio', { name: 'باقة كاملة' }));
    await user.type(within(panel).getByLabelText('السبب'), 'اختبار تجريبي');
    await user.click(within(panel).getByRole('button', { name: 'امنح' }));

    await waitFor(() =>
      expect(platformAccountsApi.grantPlan).toHaveBeenCalledWith({
        email: 'owner@example.com',
        planTier: 'PREMIUM',
        days: 30,
        reason: 'اختبار تجريبي',
      }),
    );
    expect(platformAccountsApi.grantFeatures).not.toHaveBeenCalled();
  });

  it('G3 — the feature checkboxes disappear in tier mode, because the tier decides them', async () => {
    const { user, panel } = await openPanel();

    expect(within(panel).getByRole('group', { name: 'المزايا' })).toBeInTheDocument();
    await user.click(within(panel).getByRole('radio', { name: 'باقة كاملة' }));
    expect(within(panel).queryByRole('group', { name: 'المزايا' })).not.toBeInTheDocument();
  });

  it('G4 — PLAN_CATALOGUE_EMPTY is named, and points at the screen that fixes it', async () => {
    const { user, panel } = await openPanel();
    // The REAL ApiError, with the REAL positional signature — so a change to
    // that signature breaks this test rather than letting the panel silently
    // stop recognising the one refusal it is built to explain.
    platformAccountsApi.grantPlan.mockRejectedValue(
      new ApiError('Plan catalogue is empty.', 409, 'PLAN_CATALOGUE_EMPTY'),
    );

    await user.click(within(panel).getByRole('radio', { name: 'باقة كاملة' }));
    await user.type(within(panel).getByLabelText('السبب'), 'اختبار تجريبي');
    await user.click(within(panel).getByRole('button', { name: 'امنح' }));

    // Named, not smoothed into "something went wrong" — and explicitly saying
    // NOTHING was granted, because a 409 that only says "conflict" leaves an
    // operator wondering whether half of it landed.
    expect(await screen.findByText(/كتالوج الباقات فارغ/)).toBeInTheDocument();
    expect(within(panel).getByText(/لم يُمنح شيء/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /عرّف الباقة/ })).toHaveAttribute('href', '/platform/plans');
  });

  it('G5 — revoking goes through a real dialog that states the blast radius', async () => {
    const { user, panel } = await openPanel();
    platformAccountsApi.revoke.mockResolvedValue({ familyId: ROW.familyId, revokedCount: 3 });

    await user.type(within(panel).getByLabelText('السبب'), 'انتهاء التجربة');
    await user.click(within(panel).getByRole('button', { name: 'اسحب كل المنح' }));

    const dialog = await screen.findByRole('dialog');
    // It ends EVERY entitlement, including one from a real payment.
    expect(dialog).toHaveTextContent(/كل استحقاقات الأسرة/);
    expect(platformAccountsApi.revoke).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'اسحب كل المنح' }));
    await waitFor(() =>
      expect(platformAccountsApi.revoke).toHaveBeenCalledWith({
        email: 'owner@example.com',
        reason: 'انتهاء التجربة',
      }),
    );
  });
});
