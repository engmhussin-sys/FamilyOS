import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import { Card } from '../../../shared/components/Card';

/** Mirrors apps/backend/.../presentation/dto/register.dto.ts — client-side
 * validation is a UX convenience only; the backend DTO is the source of truth. */
function validatePassword(password: string): string | undefined {
  if (password.length < 10) return 'كلمة المرور يجب أن تكون 10 أحرف على الأقل.';
  if (!/(?=.*[A-Za-z])(?=.*\d)/.test(password)) {
    return 'يجب أن تحتوي كلمة المرور على حرف ورقم واحد على الأقل.';
  }
  return undefined;
}

export function RegisterPage() {
  const register = useAuthStore((s) => s.register);
  const navigate = useNavigate();

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
      setFormError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-guardian-950 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-sand-50">
          <h1 className="font-display text-2xl">إنشاء حساب العائلة</h1>
          <p className="text-center text-sm text-sand-200/70">
            دقيقة واحدة، وستبدأ بمتابعة عائلتك بأمان
          </p>
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <Input
              label="الاسم الكامل"
              autoComplete="name"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
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
              autoComplete="new-password"
              required
              hint="10 أحرف على الأقل، تحتوي على حرف ورقم"
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
              إنشاء الحساب
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-sm text-sand-200/70">
          لديك حساب بالفعل؟{' '}
          <Link to="/login" className="font-medium text-amber-500 hover:underline">
            دخول
          </Link>
        </p>
      </div>
    </div>
  );
}
