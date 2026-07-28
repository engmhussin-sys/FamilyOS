import { type ReactNode } from 'react';
import { useAuthStore } from '../../auth/store/authStore';
import { Button } from '../../../shared/components/Button';

export function DashboardShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="flex min-h-screen bg-sand-50">
      <aside className="flex w-60 shrink-0 flex-col bg-guardian-950 px-5 py-6 text-sand-50">
        <span className="font-display text-lg">AI Family Coach</span>
        <nav className="mt-10 flex flex-col gap-1 text-sm">
          <span className="rounded-card bg-guardian-700/60 px-3 py-2 font-medium">
            نظرة عامة
          </span>
          <span className="cursor-not-allowed rounded-card px-3 py-2 text-sand-200/40">
            الأطفال (قريبًا)
          </span>
          <span className="cursor-not-allowed rounded-card px-3 py-2 text-sand-200/40">
            التقارير (قريبًا)
          </span>
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-sand-200 bg-white px-8 py-4">
          <div>
            <p className="text-sm text-ink-soft">مرحبًا بعودتك</p>
            <p className="font-medium text-ink">{user?.fullName}</p>
          </div>
          <Button variant="ghost" onClick={() => logout()}>
            تسجيل الخروج
          </Button>
        </header>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
