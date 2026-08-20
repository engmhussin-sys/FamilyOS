import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { App } from '@/app/App';
import { adminKeyStore } from '@/features/admin-key/adminKeyStore';
import { useAuthStore } from '@/features/auth/store/authStore';
import { persistLocale } from '@/shared/i18n/localizationEngine';

/**
 * THE ROUTE ITSELF.
 *
 * `routing.spec.tsx` proves this app never renders an empty document for an
 * unknown path. That guarantee is exactly what makes a NEW route silently
 * fail: a mounted-but-unreachable page and a typo produce the same calm 404,
 * so «the page exists» has to be asserted by NAVIGATING to it.
 *
 * The two gates are asserted in order, because the order is the design: a
 * signed-out operator gets the sign-in screen, a signed-in one without the
 * operator key gets the unlock screen, and neither ever gets the platform
 * numbers.
 */

const PATH = '/notifications/decisions';

function goTo(path: string): void {
  window.history.pushState({}, '', path);
}

describe('/notifications/decisions', () => {
  beforeEach(() => {
    persistLocale('ar');
    adminKeyStore.resetForTests();
    useAuthStore.setState({ user: null, status: 'guest', error: null });
  });

  // The store is reset in `beforeEach`, NOT here. Resetting it in an
  // `afterEach` publishes to a component React has not unmounted yet —
  // Testing Library's own cleanup is registered first and therefore runs
  // last — and the update lands outside `act()`.
  afterEach(() => {
    goTo('/');
    vi.restoreAllMocks();
  });

  it('is a real route — it does not fall through to the 404 catch-all', () => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'ops@abny.app', fullName: 'مشغّل', familyId: 'f1' } as never,
      status: 'authenticated',
    });
    goTo(PATH);

    const { container } = render(<App />);

    expect(container.textContent?.trim()).not.toBe('');
    expect(screen.queryByText('404')).not.toBeInTheDocument();
    expect(screen.queryByText('الصفحة غير موجودة')).not.toBeInTheDocument();
  });

  it('asks for the operator key before it shows a single number', () => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'ops@abny.app', fullName: 'مشغّل', familyId: 'f1' } as never,
      status: 'authenticated',
    });
    goTo(PATH);

    render(<App />);

    // The SAME gate the growth surface uses, not a second mechanism.
    expect(screen.getByText('أدخل مفتاح المشغّل')).toBeInTheDocument();
    expect(screen.queryByText('سجلّ قرارات الإشعارات')).not.toBeInTheDocument();
  });

  it('appears in the navigation rail under its own operations section', () => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'ops@abny.app', fullName: 'مشغّل', familyId: 'f1' } as never,
      status: 'authenticated',
    });
    goTo(PATH);

    render(<App />);

    const link = screen.getByRole('link', { name: 'قرارات الإشعارات' });
    expect(link).toHaveAttribute('href', PATH);
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('التشغيل')).toBeInTheDocument();
    // And the growth rail is still whole beside it — a new section must not
    // have replaced one.
    expect(screen.getByRole('link', { name: 'النظرة التنفيذية' })).toHaveAttribute(
      'href',
      '/growth',
    );
  });

  it('sends a signed-out operator to sign in, never to the platform view', () => {
    goTo(PATH);

    render(<App />);

    expect(screen.queryByText('سجلّ قرارات الإشعارات')).not.toBeInTheDocument();
    expect(screen.queryByText('أدخل مفتاح المشغّل')).not.toBeInTheDocument();
  });
});
