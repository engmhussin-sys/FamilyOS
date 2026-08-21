import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { App } from '@/app/App';
import { adminKeyStore } from '@/features/admin-key/adminKeyStore';
import { useAuthStore } from '@/features/auth/store/authStore';
import { persistLocale } from '@/shared/i18n/localizationEngine';

/**
 * ===========================================================================
 * THE FOUR ROUTES THAT WERE BUILT BEFORE THE PAGES WERE.
 * ===========================================================================
 *
 * Twelve operator endpoints existed behind `InternalAdminGuard`, audited and
 * unreachable, because nothing in the browser called them. That is precisely
 * the failure mode this file guards against, and the guard has to NAVIGATE:
 * `routing.spec.tsx` proves the app never renders an empty document for an
 * unknown path, which means a page that was never mounted and a typo in a link
 * produce the identical calm 404. «The screen exists» is only provable by
 * asking the router for it.
 *
 * And the two gates are asserted in order on every one of them, because a new
 * operator screen is exactly where a gate gets forgotten: signed out ⇒ sign in;
 * signed in without the operator key ⇒ the unlock screen; and in neither case
 * a single platform number.
 */

const SCREENS = [
  { path: '/platform/jobs', nav: 'المهام المجدولة', heading: 'المهام المجدولة' },
  { path: '/platform/outbox', nav: 'الصندوق الصادر والرسائل الميّتة', heading: 'الصندوق الصادر والرسائل الميّتة' },
  { path: '/platform/deliveries', nav: 'تراكم الإشعارات', heading: 'تراكم الإشعارات' },
  { path: '/platform/ai-usage', nav: 'تكلفة الذكاء الاصطناعي', heading: 'تكلفة الذكاء الاصطناعي' },
] as const;

function goTo(path: string): void {
  window.history.pushState({}, '', path);
}

function signIn(): void {
  useAuthStore.setState({
    user: { id: 'u1', email: 'ops@abny.app', fullName: 'مشغّل', familyId: 'f1' } as never,
    status: 'authenticated',
  });
}

describe('the four operations screens', () => {
  beforeEach(() => {
    persistLocale('ar');
    adminKeyStore.resetForTests();
    useAuthStore.setState({ user: null, status: 'guest', error: null });
  });

  afterEach(() => {
    goTo('/');
    vi.restoreAllMocks();
  });

  it.each(SCREENS)('$path is a real route, not the 404 catch-all', ({ path }) => {
    signIn();
    goTo(path);

    const { container } = render(<App />);

    expect(container.textContent?.trim()).not.toBe('');
    expect(screen.queryByText('الصفحة غير موجودة')).not.toBeInTheDocument();
  });

  it.each(SCREENS)('$path asks for the operator key before it renders anything', ({ path, heading }) => {
    signIn();
    goTo(path);

    render(<App />);

    // The SAME gate every other platform screen uses — not a second mechanism
    // invented for these four.
    expect(screen.getByText('أدخل مفتاح المشغّل')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();
  });

  it.each(SCREENS)('$path is reachable from the operations rail', ({ path, nav }) => {
    signIn();
    goTo(path);

    render(<App />);

    const link = screen.getByRole('link', { name: nav });
    expect(link).toHaveAttribute('href', path);
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it.each(SCREENS)('$path sends a signed-out operator to sign in, never to the screen', ({ path, heading }) => {
    goTo(path);

    render(<App />);

    expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();
    // Not even the unlock screen: the session gate is the outer one.
    expect(screen.queryByText('أدخل مفتاح المشغّل')).not.toBeInTheDocument();
  });

  it('adds the four without displacing the screens that were already there', () => {
    signIn();
    goTo('/platform/accounts');

    render(<App />);

    for (const name of ['الحسابات', 'صحّة المنصّة', 'الباقات والأسعار', 'طابور الدعم', 'قرارات الإشعارات']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
    // And the growth rail is still whole beside them.
    expect(screen.getByRole('link', { name: 'النظرة التنفيذية' })).toHaveAttribute('href', '/growth');
  });
});
