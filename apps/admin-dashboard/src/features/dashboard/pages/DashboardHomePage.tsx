import { useAuthStore } from '../../auth/store/authStore';
import { Card } from '../../../shared/components/Card';
import { ChildrenListCard } from '../../children/components/ChildrenListCard';
import { PairingCard } from '../../pairing/components/PairingCard';
import { DeviceStatusCard } from '../../devices/components/DeviceStatusCard';
import { ScreenTimePolicyCard } from '../../screen-time/components/ScreenTimePolicyCard';

export function DashboardHomePage() {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h1 className="font-display text-xl text-ink">عائلتك</h1>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-ink-soft">البريد الإلكتروني</dt>
            <dd className="mt-1 font-medium text-ink">{user?.email}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">الدور</dt>
            <dd className="mt-1 font-medium text-ink">
              {user?.familyRole === 'OWNER' ? 'مالك العائلة' : 'والد/والدة'}
            </dd>
          </div>
        </dl>
      </Card>

      <ChildrenListCard />
      <PairingCard />
      <DeviceStatusCard />
      <ScreenTimePolicyCard />
    </div>
  );
}
