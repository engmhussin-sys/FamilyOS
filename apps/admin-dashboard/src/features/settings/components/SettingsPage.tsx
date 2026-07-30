import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/settingsApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

type Tab = 'profile' | 'family' | 'billing';

function ProfileTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: settingsApi.getProfile });
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: () => settingsApi.updateProfile({ fullName: fullName || undefined, phone: phone || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <Input
        label={t('settings.fullName')}
        defaultValue={profile?.fullName}
        onChange={(e) => setFullName(e.target.value)}
      />
      <Input
        label={t('settings.phone')}
        defaultValue={profile?.phone ?? ''}
        onChange={(e) => setPhone(e.target.value)}
      />
      <Button onClick={() => mutation.mutate()} isLoading={mutation.isPending} className="w-fit">
        {t('common.save')}
      </Button>
      {saved && <p className="text-xs text-sage-600">{t('settings.saved')}</p>}
    </div>
  );
}

function FamilyTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['family-settings'], queryFn: settingsApi.getFamilySettings });
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: () => settingsApi.updateFamilySettings({ name: name || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['family-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <Input
        label={t('settings.familyName')}
        defaultValue={settings?.name}
        onChange={(e) => setName(e.target.value)}
      />
      <p className="text-xs text-ink-soft">{t('settings.timezone')}: {settings?.timezone}</p>
      <Button onClick={() => mutation.mutate()} isLoading={mutation.isPending} className="w-fit">
        {t('common.save')}
      </Button>
      {saved && <p className="text-xs text-sage-600">{t('settings.saved')}</p>}
    </div>
  );
}

function BillingTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: plans } = useQuery({ queryKey: ['billing-plans'], queryFn: settingsApi.listPlans });
  const { data: subscriptionInfo } = useQuery({ queryKey: ['subscription'], queryFn: settingsApi.getSubscription });
  const { data: history } = useQuery({ queryKey: ['billing-history'], queryFn: settingsApi.getBillingHistory });
  const [error, setError] = useState<string | null>(null);

  const startTrialMutation = useMutation({
    mutationFn: settingsApi.startTrial,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['subscription'] }),
  });

  const subscribeMutation = useMutation({
    mutationFn: (tier: string) => settingsApi.subscribe(tier, 'MANUAL'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscription'] });
      queryClient.invalidateQueries({ queryKey: ['billing-history'] });
    },
    onError: () => setError(t('billing.providerNotConfigured')),
  });

  const cancelMutation = useMutation({
    mutationFn: settingsApi.cancelSubscription,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['subscription'] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium text-ink">{t('billing.currentPlan')}</h3>
        {subscriptionInfo?.subscription ? (
          <p className="text-xs text-ink-soft">
            {subscriptionInfo.subscription.planTier} — {subscriptionInfo.subscription.status}
            {subscriptionInfo.isInTrial && ` · ${t('billing.trialDaysLeft', { days: subscriptionInfo.trialDaysRemaining })}`}
          </p>
        ) : (
          <Button variant="secondary" onClick={() => startTrialMutation.mutate()} isLoading={startTrialMutation.isPending}>
            {t('billing.startTrial')}
          </Button>
        )}
        {subscriptionInfo?.subscription?.status === 'ACTIVE' && (
          <Button variant="ghost" className="mt-2" onClick={() => cancelMutation.mutate()}>
            {t('billing.cancel')}
          </Button>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium text-ink">Plans</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {plans?.map((plan) => (
            <Button
              key={plan.tier}
              variant="ghost"
              onClick={() => subscribeMutation.mutate(plan.tier)}
              isLoading={subscribeMutation.isPending}
            >
              {plan.name} — {(plan.priceCents / 100).toFixed(2)} {plan.currency}
            </Button>
          ))}
        </div>
        {error && <p className="mt-2 text-xs text-brick-600">{error}</p>}
      </div>

      <div>
        <h3 className="text-sm font-medium text-ink">{t('billing.history')}</h3>
        {!history || history.length === 0 ? (
          <p className="text-xs text-ink-soft">{t('billing.noHistory')}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 text-xs text-ink-soft">
            {history.map((invoice) => (
              <li key={invoice.id}>
                {new Date(invoice.issuedAt).toLocaleDateString()} — {(invoice.amountCents / 100).toFixed(2)} {invoice.currency} ({invoice.status})
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('profile');

  return (
    <Card>
      <h1 className="font-display text-xl text-ink">{t('settings.title')}</h1>
      <div className="mt-4 flex gap-2 border-b border-sand-200 pb-2">
        {(['profile', 'family', 'billing'] as Tab[]).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`rounded-card px-3 py-1.5 text-sm ${
              tab === tabKey ? 'bg-guardian-900 text-sand-50' : 'text-ink-soft'
            }`}
          >
            {t(`settings.${tabKey}Tab`)}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {tab === 'profile' && <ProfileTab />}
        {tab === 'family' && <FamilyTab />}
        {tab === 'billing' && <BillingTab />}
      </div>
    </Card>
  );
}
