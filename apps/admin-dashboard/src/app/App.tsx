import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import { LoginPage } from '../features/auth/pages/LoginPage';
import { RegisterPage } from '../features/auth/pages/RegisterPage';
import { DashboardHomePage } from '../features/dashboard/pages/DashboardHomePage';
import { DashboardShell } from '../features/dashboard/components/DashboardShell';
import { SettingsPage } from '../features/settings/components/SettingsPage';
import { OrganizationPage } from '../features/organization/pages/OrganizationPage';
import { AcceptInvitationPage } from '../features/organization/pages/AcceptInvitationPage';
import { ExecutiveOverviewPage } from '../features/growth/pages/ExecutiveOverviewPage';
import { FunnelPage } from '../features/growth/pages/FunnelPage';
import { ForecastPage } from '../features/growth/pages/ForecastPage';
import { RetentionPage } from '../features/growth/pages/RetentionPage';
import { UnitEconomicsPage } from '../features/growth/pages/UnitEconomicsPage';
import { AcquisitionPage } from '../features/growth/pages/AcquisitionPage';
import { ReferralPage } from '../features/growth/pages/ReferralPage';
import { ProductAiPage } from '../features/growth/pages/ProductAiPage';
import { NotificationDecisionsPage } from '../features/notifications/pages/NotificationDecisionsPage';
import { AccountsPage } from '../features/platform/pages/AccountsPage';
import { ProtectedRoute } from './ProtectedRoute';
import { NotFoundPage } from './NotFoundPage';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { AdminKeyGate } from '../features/admin-key/AdminKeyGate';
import { LocaleProvider } from '../shared/i18n/LocaleProvider';
import type { ReactNode } from 'react';

/**
 * Every platform-admin view sits behind BOTH gates, in this order: the
 * parent session (ProtectedRoute) and then the operator key (AdminKeyGate),
 * which is what the backend's `InternalAdminGuard` actually checks. The
 * family-facing routes below deliberately do not mount `AdminKeyGate` at all
 * — they need no key and keep working without one.
 */
function PlatformAdminScreen({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute>
      <DashboardShell>
        <AdminKeyGate>{children}</AdminKeyGate>
      </DashboardShell>
    </ProtectedRoute>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

export function App() {
  return (
    <LocaleProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          {/* Inside the router and inside the LocaleProvider on purpose: the
              fallback needs `t()` and a `<Link>`, and a boundary placed above
              either of them could only render untranslated English. */}
          <RouteErrorBoundary>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <DashboardHomePage />
                  </DashboardShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <SettingsPage />
                  </DashboardShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/organization"
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <OrganizationPage />
                  </DashboardShell>
                </ProtectedRoute>
              }
            />
            {/* The executive / commercial surface. Every one of these is
                behind ProtectedRoute AND behind the backend's
                InternalAdminGuard — there is no family-scoped variant of
                any of them, by design: "how many families converted in
                Egypt" is not a question a tenant may ask. */}
            <Route
              path="/growth"
              element={<PlatformAdminScreen><ExecutiveOverviewPage /></PlatformAdminScreen>}
            />
            <Route
              path="/growth/funnel"
              element={<PlatformAdminScreen><FunnelPage /></PlatformAdminScreen>}
            />
            <Route
              path="/growth/forecast"
              element={<PlatformAdminScreen><ForecastPage /></PlatformAdminScreen>}
            />
            <Route
              path="/growth/retention"
              element={<PlatformAdminScreen><RetentionPage /></PlatformAdminScreen>}
            />
            <Route
              path="/growth/unit-economics"
              element={<PlatformAdminScreen><UnitEconomicsPage /></PlatformAdminScreen>}
            />
            <Route
              path="/growth/acquisition"
              element={<PlatformAdminScreen><AcquisitionPage /></PlatformAdminScreen>}
            />
            <Route
              path="/growth/referral"
              element={<PlatformAdminScreen><ReferralPage /></PlatformAdminScreen>}
            />
            <Route
              path="/growth/product"
              element={<PlatformAdminScreen><ProductAiPage /></PlatformAdminScreen>}
            />
            {/* The operations surface. Same two gates as /growth/* and for
                the same reason: the backend route behind it is
                `InternalAdminGuard`-only and has no family-scoped variant —
                «which audience is the suppression in» is not a question a
                tenant may ask. */}
            {/*
              THE PLATFORM OWNER'S REGISTER. Behind both gates like every other
              operator screen: the parent session, then the operator key. It is
              the only view in this dashboard that lists households as rows.
            */}
            <Route
              path="/platform/accounts"
              element={<PlatformAdminScreen><AccountsPage /></PlatformAdminScreen>}
            />
            <Route
              path="/notifications/decisions"
              element={
                <PlatformAdminScreen>
                  <NotificationDecisionsPage />
                </PlatformAdminScreen>
              }
            />
            <Route
              path="/invitations/:invitationId/accept"
              element={
                <ProtectedRoute>
                  <AcceptInvitationPage />
                </ProtectedRoute>
              }
            />
            {/* MUST BE LAST, and must exist at all. Without it react-router
                matches nothing and renders an EMPTY DOCUMENT for any typo,
                stale bookmark or demo link to a route that has moved — no
                navigation, no message, no way back but the address bar.
                `NotFoundPage` answers signed-in operators inside the shell and
                signed-out ones standalone; see that file for why it is not
                simply wrapped in ProtectedRoute. */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
          </RouteErrorBoundary>
        </BrowserRouter>
      </QueryClientProvider>
    </LocaleProvider>
  );
}
