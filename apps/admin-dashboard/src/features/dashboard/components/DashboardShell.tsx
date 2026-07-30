import { type ReactNode } from 'react';
import { useAuthStore } from '../../auth/store/authStore';
import { Button } from '../../../shared/components/Button';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { LanguageSwitcher } from '../../../shared/i18n/LanguageSwitcher';

export function DashboardShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen bg-sand-50">
      <aside className="flex w-60 shrink-0 flex-col bg-guardian-950 px-5 py-6 text-sand-50">
        <span className="font-display text-lg">{t('shell.appName')}</span>
        <nav className="mt-10 flex flex-col gap-1 text-sm">
          <span className="rounded-card bg-guardian-700/60 px-3 py-2 font-medium">
            {t('shell.navOverview')}
          </span>
          <span className="cursor-not-allowed rounded-card px-3 py-2 text-sand-200/40">
            {t('shell.navChildren')} {t('common.comingSoon')}
          </span>
          <span className="cursor-not-allowed rounded-card px-3 py-2 text-sand-200/40">
            {t('shell.navReports')} {t('common.comingSoon')}
          </span>
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-sand-200 bg-white px-8 py-4">
          <div>
            <p className="text-sm text-ink-soft">{t('shell.welcomeBack')}</p>
            <p className="font-medium text-ink">{user?.fullName}</p>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
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
