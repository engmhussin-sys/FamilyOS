import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Card } from '../shared/components/Card';
import { Button } from '../shared/components/Button';
import { useTranslation } from '../shared/i18n/LocaleProvider';

/**
 * THE SECOND WAY THIS APP RENDERED AN EMPTY DOCUMENT, found while adding the
 * 404 route.
 *
 * React 18 unmounts the ENTIRE tree when a render throws and no error boundary
 * is above it, and this app had none — `grep -r ErrorBoundary src/` returned
 * nothing. So a single component that threw produced exactly the same failure
 * as an unknown URL: a blank page, no navigation, no message, nothing to
 * report except "it went white". On a demo that is indistinguishable from the
 * app being broken outright.
 *
 * This does NOT pretend the error did not happen and it does NOT retry
 * automatically. It prints the message, keeps `console.error` (so the real
 * stack is still in the browser console and in whatever collects it), and
 * gives the operator a way back to a page that works. `resetKey` is not
 * offered: re-rendering the same subtree that just threw usually just throws
 * again, and a button that appears to do nothing is worse than a link.
 */
function ErrorFallback({ error }: { error: Error | null }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen items-center justify-center bg-sand-50 p-6">
      <Card className="mx-auto max-w-xl">
        <h1 className="font-display text-xl text-ink">{t('appError.title')}</h1>
        <p className="mt-2 text-sm text-ink-soft">{t('appError.body')}</p>

        {/* The raw message, in a monospace block and marked `ltr` because it
            is almost always English text from a library. Shown rather than
            hidden: an operator who can read it can tell an engineer what
            broke. It is inserted as TEXT — React escapes it. */}
        {error?.message && (
          <p
            dir="ltr"
            className="mt-4 wrap-break-word rounded-card bg-sand-100 px-3 py-2 text-start font-mono text-xs text-ink-soft"
          >
            {error.message}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {/* A full document load, not a client-side navigation: the React
              tree that threw is already unmounted, and remounting it in place
              is how you get a second blank page. */}
          <Link to="/" reloadDocument>
            <Button>{t('appError.backToOverview')}</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}

interface RouteErrorBoundaryState {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<{ children: ReactNode }, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Deliberately still logged. Swallowing it here would trade a blank page
    // for a silent one, which is the worse of the two.
    // eslint-disable-next-line no-console
    console.error('Unhandled render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) return <ErrorFallback error={this.state.error} />;
    return this.props.children;
  }
}
