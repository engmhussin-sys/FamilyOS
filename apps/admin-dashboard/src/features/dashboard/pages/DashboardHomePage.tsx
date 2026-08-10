import { useAuthStore } from '../../auth/store/authStore';
import { Card } from '../../../shared/components/Card';
import { ChildrenListCard } from '../../children/components/ChildrenListCard';
import { PairingCard } from '../../pairing/components/PairingCard';
import { DeviceStatusCard } from '../../devices/components/DeviceStatusCard';
import { ScreenTimePolicyCard } from '../../screen-time/components/ScreenTimePolicyCard';
import { RuntimeTimelineCard } from '../../runtime/components/RuntimeTimelineCard';
import { NotificationCenterCard } from '../../notifications/components/NotificationCenterCard';
import { FamilyInsightsCard } from '../../insights/components/FamilyInsightsCard';
import { DigitalTwinCard } from '../../life-intelligence/components/DigitalTwinCard';
import { LifeTimelineCard } from '../../life-intelligence/components/LifeTimelineCard';
import { HabitTrackerCard } from '../../life-intelligence/components/HabitTrackerCard';
import { HealthTrendCard } from '../../life-intelligence/components/HealthTrendCard';
import { FaithProgressCard } from '../../life-intelligence/components/FaithProgressCard';
import { FamilyStoreManagerCard } from '../../life-intelligence/components/FamilyStoreManagerCard';
import { CoachingRecommendationsCard } from '../../life-intelligence/components/CoachingRecommendationsCard';
import { ReportsCard } from '../../reports/components/ReportsCard';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

export function DashboardHomePage() {
  const user = useAuthStore((s) => s.user);
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      <NotificationCenterCard />
      <Card>
        <h1 className="font-display text-xl text-ink">{t('dashboard.familyTitle')}</h1>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-ink-soft">{t('dashboard.email')}</dt>
            <dd className="mt-1 font-medium text-ink">{user?.email}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">{t('dashboard.role')}</dt>
            <dd className="mt-1 font-medium text-ink">
              {user?.familyRole === 'OWNER' ? t('dashboard.roleOwner') : t('dashboard.roleParent')}
            </dd>
          </div>
        </dl>
      </Card>

      <ChildrenListCard />
      <PairingCard />
      <DeviceStatusCard />
      <ScreenTimePolicyCard />
      <RuntimeTimelineCard />
      <FamilyInsightsCard />
      <DigitalTwinCard />
      <CoachingRecommendationsCard />
      <HabitTrackerCard />
      <HealthTrendCard />
      <FaithProgressCard />
      <FamilyStoreManagerCard />
      <LifeTimelineCard />
      <ReportsCard />
    </div>
  );
}
