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
import { ProtectedRoute } from './ProtectedRoute';
import { LocaleProvider } from '../shared/i18n/LocaleProvider';

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
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <ExecutiveOverviewPage />
                  </DashboardShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/growth/funnel"
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <FunnelPage />
                  </DashboardShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/growth/forecast"
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <ForecastPage />
                  </DashboardShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/growth/retention"
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <RetentionPage />
                  </DashboardShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/growth/unit-economics"
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <UnitEconomicsPage />
                  </DashboardShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/growth/acquisition"
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <AcquisitionPage />
                  </DashboardShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/growth/referral"
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <ReferralPage />
                  </DashboardShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/growth/product"
              element={
                <ProtectedRoute>
                  <DashboardShell>
                    <ProductAiPage />
                  </DashboardShell>
                </ProtectedRoute>
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
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </LocaleProvider>
  );
}
