import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import { LoginPage } from '../features/auth/pages/LoginPage';
import { RegisterPage } from '../features/auth/pages/RegisterPage';
import { DashboardHomePage } from '../features/dashboard/pages/DashboardHomePage';
import { DashboardShell } from '../features/dashboard/components/DashboardShell';
import { SettingsPage } from '../features/settings/components/SettingsPage';
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
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </LocaleProvider>
  );
}
