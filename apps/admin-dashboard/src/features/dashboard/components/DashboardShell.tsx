import { type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../auth/store/authStore';
import { Button } from '../../../shared/components/Button';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { LanguageSwitcher } from '../../../shared/i18n/LanguageSwitcher';
import { SearchBar } from '../../search/components/SearchBar';
import { AdminKeyLockButton } from '../../admin-key/AdminKeyGate';

/**
 * The growth surface's nav, ordered by what an operator opens first rather
 * than alphabetically: the executive overview, then the funnel (where
 * families stop), then the commitments, then the detail views.
 */
const GROWTH_ROUTES: ReadonlyArray<{ to: string; labelKey: string }> = [
  { to: '/growth', labelKey: 'growth.nav.overview' },
  { to: '/growth/funnel', labelKey: 'growth.nav.funnel' },
  { to: '/growth/forecast', labelKey: 'growth.nav.forecast' },
  { to: '/growth/retention', labelKey: 'growth.nav.retention' },
  { to: '/growth/unit-economics', labelKey: 'growth.nav.unitEconomics' },
  { to: '/growth/acquisition', labelKey: 'growth.nav.acquisition' },
  { to: '/growth/referral', labelKey: 'growth.nav.referral' },
  { to: '/growth/product', labelKey: 'growth.nav.product' },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { t } = useTranslation();
  const { pathname } = useLocation();

  return (
    <div className="flex min-h-screen bg-sand-50">
      <aside className="flex w-60 shrink-0 flex-col bg-guardian-950 px-5 py-6 text-sand-50">
        <span className="font-display text-lg">{t('shell.appName')}</span>
        <nav className="mt-10 flex flex-col gap-1 text-sm">
          <Link to="/" className="rounded-card bg-guardian-700/60 px-3 py-2 font-medium">
            {t('shell.navOverview')}
          </Link>
          <span className="cursor-not-allowed rounded-card px-3 py-2 text-sand-200/40">
            {t('shell.navChildren')} {t('common.comingSoon')}
          </span>
          <Link to="/organization" className="rounded-card px-3 py-2 hover:bg-guardian-700/40">
            {t('shell.navOrganization')}
          </Link>
          <Link to="/settings" className="rounded-card px-3 py-2 hover:bg-guardian-700/40">
            {t('shell.navSettings')}
          </Link>

          <span className="mt-6 px-3 text-[11px] font-medium uppercase tracking-wide text-sand-200/50">
            {t('growth.nav.section')}
          </span>
          {GROWTH_ROUTES.map((route) => (
            <Link
              key={route.to}
              to={route.to}
              aria-current={pathname === route.to ? 'page' : undefined}
              className={`rounded-card px-3 py-2 ${
                pathname === route.to ? 'bg-guardian-700/60 font-medium' : 'hover:bg-guardian-700/40'
              }`}
            >
              {t(route.labelKey)}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-sand-200 bg-white px-8 py-4">
          <div>
            <p className="text-sm text-ink-soft">{t('shell.welcomeBack')}</p>
            <p className="font-medium text-ink">{user?.fullName}</p>
          </div>
          <SearchBar />
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            {/* Renders only while an operator key is held: locking is a real
                action here, not a decorative one — it wipes the key out of
                memory and returns the platform views to the unlock screen. */}
            <AdminKeyLockButton />
            <Button variant="ghost" onClick={() => logout()}>
              {t('shell.logout')}
            </Button>
          </div>
        </header>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
