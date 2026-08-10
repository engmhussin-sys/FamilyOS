import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';

import { organizationApi } from '../api/organizationApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

/**
 * CLOSES A CRITICAL GAP found in a final review: the backend's
 * acceptInvitation endpoint existed with zero UI anywhere to reach
 * it — a person receiving an invitation had no way to actually
 * accept it. Reached via a direct link (e.g.
 * /invitations/:invitationId/accept) rather than app navigation,
 * same as any real invitation-link pattern; ProtectedRoute already
 * handles "not logged in yet" by redirecting to /login and back
 * here afterward (LoginPage already reads location.state.from).
 */
export function AcceptInvitationPage() {
  const { invitationId } = useParams<{ invitationId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const acceptMutation = useMutation({
    mutationFn: () => organizationApi.acceptInvitation(invitationId!),
    onSuccess: () => navigate('/organization', { replace: true }),
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-sand-50 p-6">
      <Card>
        <div className="max-w-sm">
          <h1 className="font-display text-xl text-ink">{t('organization.acceptInvitationTitle')}</h1>
          <p className="mt-2 text-sm text-ink-soft">{t('organization.acceptInvitationBody')}</p>
          {error && <p className="mt-3 text-xs text-brick-600">{error}</p>}
          <Button
            onClick={() => acceptMutation.mutate()}
            isLoading={acceptMutation.isPending}
            disabled={!invitationId}
            className="mt-4 w-fit"
          >
            {t('organization.acceptInvitationButton')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
