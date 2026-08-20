import { Link, useLocation, useNavigate } from 'react-router-dom';

import { Card } from '../shared/components/Card';
import { Button } from '../shared/components/Button';
import { useTranslation } from '../shared/i18n/LocaleProvider';
import { useAuthStore } from '../features/auth/store/authStore';
import { DashboardShell } from '../features/dashboard/components/DashboardShell';

/**
 * CLOSES A DEMO-BREAKING GAP: `<Routes>` had no `path="*"`, so any URL that
 * matched none of the declared routes rendered NOTHING. Not a message, not the
 * navigation rail — an empty `<body>`, with no way back except editing the
 * address bar. A typo, a stale bookmark or a link to a route that has since
 * moved all produced the same blank document.
 *
 * WHY THIS IS NOT SIMPLY MOUNTED INSIDE `ProtectedRoute` + `DashboardShell`.
 * `ProtectedRoute` redirects a guest to `/login` carrying `state.from`, and
 * `LoginPage` returns them to it after a successful sign-in — so a signed-out
 * person hitting a typo'd URL would be asked to log in and then delivered back
 * to the same non-existent page. A 404 is not a permission problem, so it is
 * answered directly: signed in, it renders INSIDE the shell (the rail is the
 * way back); signed out, it renders standalone and offers the sign-in page.
 *
 * The attempted path is echoed back because on a demo laptop the difference
 * between `/growth/retention` and `/growth/retension` is the whole diagnosis.
 * React escapes it as text — it is never interpolated into markup or a URL.
 */
function NotFoundBody() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isAuthenticated = useAuthStore((s) => s.status === 'authenticated');

  return (
    <Card className="mx-auto max-w-xl">
      <p className="font-display text-4xl text-guardian-700">404</p>
      <h1 className="mt-2 font-display text-xl text-ink">{t('notFound.title')}</h1>
      <p className="mt-2 text-sm text-ink-soft">{t('notFound.body')}</p>

      {/* `dir="ltr"` on the path only: a URL is a Latin-script identifier and
          bidi reordering would show the operator a path that is not the one
          they typed. `break-all` keeps a long path inside the card. */}
      <p
        dir="ltr"
        className="mt-4 break-all rounded-card bg-sand-100 px-3 py-2 text-start font-mono text-xs text-ink-soft"
      >
        {pathname}
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {isAuthenticated ? (
          <Link to="/">
            <Button>{t('notFound.backToOverview')}</Button>
          </Link>
        ) : (
          <Link to="/login">
            <Button>{t('notFound.goToLogin')}</Button>
          </Link>
        )}
        {/* `navigate(-1)` only when there IS a history entry to go back to:
            on a pasted link this tab's history is one entry long and going
            back would leave the app entirely. */}
        {window.history.length > 1 && (
          <Button variant="ghost" onClick={() => navigate(-1)}>
            {t('notFound.goBack')}
          </Button>
        )}
      </div>
    </Card>
  );
}

export function NotFoundPage() {
  const isAuthenticated = useAuthStore((s) => s.status === 'authenticated');

  if (isAuthenticated) {
    return (
      <DashboardShell>
        <NotFoundBody />
      </DashboardShell>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-sand-50 p-6">
      <NotFoundBody />
    </div>
  );
}
