import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import { Card } from '../../../shared/components/Card';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

export function RegisterPage() {
  const { t } = useTranslation();
  const register = useAuthStore((s) => s.register);
  const navigate = useNavigate();

  /** Mirrors apps/backend/.../presentation/dto/register.dto.ts \u2014 client-side
   * validation is a UX convenience only; the backend DTO is the source of truth. */
  function validatePassword(password: string): string | undefined {
    if (password.length < 10) return t('auth.passwordTooShort');
    if (!/(?=.*[A-Za-z])(?=.*\d)/.test(password)) {
      return t('auth.passwordNeedsLetterAndDigit');
    }
    return undefined;
  }

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const passwordValidationError = validatePassword(password);
    setPasswordError(passwordValidationError);
    if (passwordValidationError) return;

    setIsSubmitting(true);
    try {
      await register({ email, password, fullName });
      navigate('/', { replace: true });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-guardian-950 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-sand-50">
          <h1 className="font-display text-2xl">{t('auth.registerTitle')}</h1>
          <p className="text-center text-sm text-sand-200/70">{t('auth.registerTagline')}</p>
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <Input
              label={t('auth.fullName')}
              autoComplete="name"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
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
              autoComplete="new-password"
              required
              hint={t('auth.passwordHint')}
              error={passwordError}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (passwordError) setPasswordError(undefined);
              }}
            />
            {formError && (
              <p role="alert" className="rounded-card bg-brick-100 px-3 py-2 text-sm text-brick-600">
                {formError}
              </p>
            )}
            <Button type="submit" isLoading={isSubmitting} className="mt-2 w-full">
              {t('auth.register')}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-sm text-sand-200/70">
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="font-medium text-amber-500 hover:underline">
            {t('auth.login')}
          </Link>
        </p>
      </div>
    </div>
  );
}
