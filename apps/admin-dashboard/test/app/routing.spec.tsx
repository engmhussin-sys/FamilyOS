import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { App } from '@/app/App';
import { RouteErrorBoundary } from '@/app/RouteErrorBoundary';
import { useAuthStore } from '@/features/auth/store/authStore';
import { persistLocale } from '@/shared/i18n/localizationEngine';
import { LocaleProvider } from '@/shared/i18n/LocaleProvider';

/**
 * THE TWO WAYS THIS APP USED TO RENDER AN EMPTY DOCUMENT.
 *
 * 1. `<Routes>` had no `path="*"`. React Router matched nothing and rendered
 *    nothing — a typo, a stale bookmark or a demo link to a moved route
 *    produced a blank `<body>` with no navigation and no way back.
 * 2. There was no error boundary anywhere in `src/`, so a single component
 *    that threw during render unmounted the WHOLE tree and produced the same
 *    blank page.
 *
 * Both assertions below are «the document is not empty AND it says something
 * true in Arabic», because "not empty" alone would pass on a spinner that
 * never resolves.
 */

const UNKNOWN_PATH = '/growth/retension';

function goTo(path: string): void {
  window.history.pushState({}, '', path);
}

describe('unknown routes', () => {
  beforeEach(() => {
    persistLocale('ar');
    useAuthStore.setState({ user: null, status: 'guest', error: null });
  });

  afterEach(() => {
    goTo('/');
    vi.restoreAllMocks();
  });

  it('renders a 404 page instead of an empty document when signed out', () => {
    goTo(UNKNOWN_PATH);

    const { container } = render(<App />);

    expect(container.textContent?.trim()).not.toBe('');
    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByText('الصفحة غير موجودة')).toBeInTheDocument();
  });

  it('echoes the path that was actually attempted, so a typo is diagnosable', () => {
    goTo(UNKNOWN_PATH);

    render(<App />);

    expect(screen.getByText(UNKNOWN_PATH)).toBeInTheDocument();
  });

  it('offers a signed-out operator the sign-in page, not a dead end', () => {
    goTo(UNKNOWN_PATH);

    render(<App />);

    const link = screen.getByRole('link', { name: 'الذهاب إلى تسجيل الدخول' });
    expect(link).toHaveAttribute('href', '/login');
  });

  it('offers a signed-in operator the overview, and keeps the navigation rail', () => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'ops@abny.app', fullName: 'مشغّل', familyId: 'f1' } as never,
      status: 'authenticated',
    });
    goTo(UNKNOWN_PATH);

    render(<App />);

    expect(screen.getByText('الصفحة غير موجودة')).toBeInTheDocument();
    // The rail is the real way back: its links are rendered alongside the 404.
    expect(screen.getByRole('link', { name: 'الإعدادات' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'العودة إلى نظرة عامة' })).toHaveAttribute('href', '/');
  });

  it('does not shadow a route that DOES exist', () => {
    goTo('/login');

    render(<App />);

    expect(screen.queryByText('404')).not.toBeInTheDocument();
  });
});

// React 19 stopped publishing a GLOBAL `JSX` namespace; it lives under the
// React namespace now, which is the change that stops two UI libraries from
// fighting over one global.
function Explodes(): React.JSX.Element {
  throw new Error('deliberate test explosion');
}

describe('a component that throws during render', () => {
  beforeEach(() => {
    persistLocale('ar');
  });

  it('shows the error page instead of blanking the whole app', () => {
    // React logs the caught error itself; silenced so the suite output stays
    // readable. The boundary's own console.error is asserted below.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { container } = render(
      <LocaleProvider>
        <MemoryRouter>
          <RouteErrorBoundary>
            <Explodes />
          </RouteErrorBoundary>
        </MemoryRouter>
      </LocaleProvider>,
    );

    expect(container.textContent?.trim()).not.toBe('');
    expect(screen.getByText('حدث خطأ غير متوقع')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'إعادة تحميل نظرة عامة' })).toHaveAttribute('href', '/');
  });

  it('still reports the error rather than swallowing it, and shows the message', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <LocaleProvider>
        <MemoryRouter>
          <RouteErrorBoundary>
            <Explodes />
          </RouteErrorBoundary>
        </MemoryRouter>
      </LocaleProvider>,
    );

    expect(screen.getByText('deliberate test explosion')).toBeInTheDocument();
    expect(consoleError.mock.calls.some((call) => call[0] === 'Unhandled render error')).toBe(true);
  });

  it('renders its children untouched when nothing throws', () => {
    render(
      <LocaleProvider>
        <MemoryRouter>
          <RouteErrorBoundary>
            <p>محتوى سليم</p>
          </RouteErrorBoundary>
        </MemoryRouter>
      </LocaleProvider>,
    );

    expect(screen.getByText('محتوى سليم')).toBeInTheDocument();
    expect(screen.queryByText('حدث خطأ غير متوقع')).not.toBeInTheDocument();
  });
});
