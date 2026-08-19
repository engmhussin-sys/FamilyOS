import { useQuery } from '@tanstack/react-query';
import { lifeIntelligenceApi, familyStoreQueryKey, RewardCatalogItem } from '../api/lifeIntelligenceApi';
import { useAuthStore } from '../../auth/store/authStore';
import { Card } from '../../../shared/components/Card';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
// A2: shared four-state boundary — this card had no error branch.
import { AsyncBoundary } from '../../../shared/components/AsyncState';

export function FamilyStoreManagerCard() {
  const { t } = useTranslation();
  const familyId = useAuthStore((s) => s.user?.familyId);

  const { data: items, isLoading, error, refetch } = useQuery<RewardCatalogItem[]>({
    queryKey: familyStoreQueryKey(familyId ?? ''),
    queryFn: () => lifeIntelligenceApi.getFamilyStore(familyId as string),
    enabled: Boolean(familyId),
  });

  if (!familyId) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('familyStore.title')}</h2>

      <AsyncBoundary
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        isEmpty={items?.length === 0}
        emptyHint={t('familyStore.empty')}
      >
        {items && items.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between rounded-card border border-sand-200 px-3 py-2">
              <p className="text-sm text-ink">{item.title}</p>
              <span className="text-sm font-semibold text-ink">{item.costCoins} {t('familyStore.coins')}</span>
            </li>
          ))}
        </ul>
        )}
      </AsyncBoundary>
    </Card>
  );
}
