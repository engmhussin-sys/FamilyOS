import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import { Card } from '../../../shared/components/Card';
import { GuardianRing } from '../../../shared/components/GuardianRing';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

export function LoginPage() {
  const { t } = useTranslation();
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setIsSubmitting(true);
    try {
      await login({ email, password });
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-guardian-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-sand-50">
          <GuardianRing progressPercent={100} size={48} />
          <h1 className="font-display text-2xl">{t('auth.loginTitle')}</h1>
          <p className="text-center text-sm text-sand-200/70">{t('auth.loginTagline')}</p>
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <Input
              label={t('auth.email')}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label={t('auth.password')}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {formError && (
              <p role="alert" className="rounded-card bg-brick-100 px-3 py-2 text-sm text-brick-600">
                {formError}
              </p>
            )}
            <Button type="submit" isLoading={isSubmitting} className="mt-2 w-full">
              {t('auth.login')}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-sm text-sand-200/70">
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="font-medium text-amber-500 hover:underline">
            {t('auth.createAccount')}
          </Link>
        </p>
      </div>
    </div>
  );
}
