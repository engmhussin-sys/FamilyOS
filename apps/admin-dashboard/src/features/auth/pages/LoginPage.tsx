import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import { Card } from '../../../shared/components/Card';
import { GuardianRing } from '../../../shared/components/GuardianRing';

export function LoginPage() {
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
      setFormError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-guardian-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-sand-50">
          <GuardianRing progressPercent={100} size={48} />
          <h1 className="font-display text-2xl">دخول الوالدين</h1>
          <p className="text-center text-sm text-sand-200/70">
            تابع، احمِ، ووجّه رحلة أطفالك الرقمية
          </p>
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <Input
              label="البريد الإلكتروني"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="كلمة المرور"
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
              دخول
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-sm text-sand-200/70">
          ليس لديك حساب؟{' '}
          <Link to="/register" className="font-medium text-amber-500 hover:underline">
            إنشاء حساب جديد
          </Link>
        </p>
      </div>
    </div>
  );
}
