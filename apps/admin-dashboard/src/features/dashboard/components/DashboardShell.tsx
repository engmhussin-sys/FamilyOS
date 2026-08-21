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

/**
 * A SECOND section, not a ninth growth item. The growth rail answers
 * commercial questions; this one answers «is the platform working». Both sit
 * behind the same operator key, but filing «why did notifications stop» under
 * «Growth & commerce» is how an operator fails to find it during an incident.
 */
const OPERATIONS_ROUTES: ReadonlyArray<{ to: string; labelKey: string }> = [
  // FIRST, because it is the only screen in this dashboard that lists
  // households as rows. Every other operator view answers a question about the
  // platform in aggregate; an owner starts from «who is this», and a register
  // filed below the decision log is a register nobody opens.
  { to: '/platform/accounts', labelKey: 'accounts.nav' },
  // Health second: it is the screen an operator opens during an incident, and
  // an incident is when hunting through a rail costs the most.
  { to: '/platform/health', labelKey: 'health.nav' },
  { to: '/platform/plans', labelKey: 'catalogue.nav' },
  { to: '/notifications/decisions', labelKey: 'notifications.decisions.nav' },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { t } = useTranslation();
  const { pathname } = useLocation();

  return (
    <div className="flex min-h-screen bg-sand-50">
      {/* The rail is sticky and scrolls on its own: on a 13" laptop the
          growth section is eight items long, and a nav that scrolls the page
          away is a nav an operator stops using. Physical `left`/`right` never
          appears here — the flex row flips with `dir`, so the rail is on the
          right in Arabic and the left in English with no extra rule. */}
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col overflow-y-auto bg-guardian-950 px-4 py-6 text-sand-50 xl:w-60 xl:px-5">
        <span className="font-display text-lg">{t('shell.appName')}</span>
        <nav aria-label={t('growth.nav.section')} className="mt-8 flex flex-col gap-1 text-sm xl:mt-10">
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

          <span className="mt-6 px-3 text-[11px] font-medium uppercase tracking-wide text-sand-200/50">
            {t('notifications.decisions.navSection')}
          </span>
          {OPERATIONS_ROUTES.map((route) => (
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
        {/* Sticky so the market/window context and the lock control stay
            reachable while a long page scrolls. `flex-wrap` is what keeps it
            honest at 1280px, where the search field would otherwise squeeze
            the operator's name to nothing. */}
        <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-sand-200 bg-white/95 px-4 py-3 backdrop-blur lg:px-6 xl:px-8 xl:py-4">
          <div className="min-w-0">
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
        {/* Capped and centred: a 2560px monitor should not stretch a KPI row
            into a horizon. */}
        <main className="mx-auto w-full max-w-[1600px] flex-1 p-4 lg:p-6 xl:p-8">{children}</main>
      </div>
    </div>
  );
}
