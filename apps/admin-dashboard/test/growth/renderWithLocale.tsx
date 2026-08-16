import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { LocaleProvider } from '@/shared/i18n/LocaleProvider';
import { persistLocale, type Locale } from '@/shared/i18n/localizationEngine';

/**
 * Renders a component inside the app's real providers rather than a mock.
 *
 * The locale is the REAL localization engine with the REAL ar.json/en.json,
 * so a test that asserts on Arabic text also proves the key exists — a
 * missing key would render as the raw key string and fail the assertion,
 * which is how "no hardcoded strings" stays true after this sprint.
 */
export function renderWithLocale(ui: ReactElement, locale: Locale = 'ar'): RenderResult {
  persistLocale(locale);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>{ui}</LocaleProvider>
    </QueryClientProvider>,
  );
}
