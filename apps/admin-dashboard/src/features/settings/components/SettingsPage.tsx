import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/settingsApi';
import { supportApi } from '../api/supportApi';
import { childrenApi, CHILDREN_QUERY_KEY } from '../../children/api/childrenApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
// A1: money has ONE renderer in this dashboard. `formatBackendMoneyMinor`
// wraps `formatMoneyMinor` for the billing payloads, which carry a currency
// but no country — see that function's header for why billing must not
// divide by 100 on its own.
import { formatBackendMoneyMinor } from '../../growth/lib/format';
// A2: the shared four-state boundary. Billing history and the consent
// switches are the two places on this page where a failed read used to
// render as a FACT — «لا توجد فواتير» and every consent unchecked.
import { AsyncBoundary, ErrorBlock } from '../../../shared/components/AsyncState';

type Tab = 'profile' | 'family' | 'billing' | 'consents' | 'account' | 'support';

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
  const { t, locale } = useTranslation();
  const queryClient = useQueryClient();
  const { data: plans } = useQuery({ queryKey: ['billing-plans'], queryFn: settingsApi.listPlans });
  const { data: subscriptionInfo } = useQuery({ queryKey: ['subscription'], queryFn: settingsApi.getSubscription });
  const {
    data: history,
    isLoading: isHistoryLoading,
    error: historyError,
    refetch: refetchHistory,
  } = useQuery({ queryKey: ['billing-history'], queryFn: settingsApi.getBillingHistory });
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
              {plan.name} — {formatBackendMoneyMinor(locale, plan.priceCents, plan.currency)}
            </Button>
          ))}
        </div>
        {error && <p className="mt-2 text-xs text-brick-600">{error}</p>}
      </div>

      <div>
        <h3 className="text-sm font-medium text-ink">{t('billing.history')}</h3>
        <AsyncBoundary
          isLoading={isHistoryLoading}
          error={historyError}
          onRetry={() => void refetchHistory()}
          isEmpty={!isHistoryLoading && !historyError && (!history || history.length === 0)}
          emptyHint={t('billing.noHistory')}
        >
          {history && history.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1 text-xs text-ink-soft">
            {history.map((invoice) => (
              <li key={invoice.id}>
                {new Date(invoice.issuedAt).toLocaleDateString()} —{' '}
                {formatBackendMoneyMinor(locale, invoice.amountCents, invoice.currency)} ({invoice.status})
              </li>
            ))}
          </ul>
          )}
        </AsyncBoundary>
      </div>
    </div>
  );
}

const CONSENT_TYPES = [
  'DATA_COLLECTION',
  'LOCATION_TRACKING',
  'APP_USAGE_MONITORING',
  'AI_BEHAVIOR_ANALYSIS',
  'KEYBOARD_BEHAVIOR_ANALYSIS',
  'HEALTH_DATA',
];

function ConsentsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: children } = useQuery({ queryKey: CHILDREN_QUERY_KEY, queryFn: childrenApi.list });
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const activeChildId = selectedChildId ?? children?.[0]?.id ?? null;

  const {
    data: consents,
    error: consentsError,
    refetch: refetchConsents,
  } = useQuery({
    queryKey: ['consents', activeChildId],
    queryFn: () => settingsApi.listConsents(activeChildId!),
    enabled: !!activeChildId,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ consentType, granted }: { consentType: string; granted: boolean }) =>
      settingsApi.setConsent(activeChildId!, consentType, granted),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['consents', activeChildId] }),
  });

  if (!children || children.length === 0) {
    return <p className="text-xs text-ink-soft">{t('consents.noChildren')}</p>;
  }

  const grantedByType = new Map((consents ?? []).map((c) => [c.consentType, c.granted]));

  return (
    <div className="flex flex-col gap-4">
      {children.length > 1 && (
        <select
          className="rounded-card border border-sand-200 px-3 py-2 text-sm"
          value={activeChildId ?? ''}
          onChange={(e) => setSelectedChildId(e.target.value)}
        >
          {children.map((child) => (
            <option key={child.id} value={child.id}>
              {child.firstName}
            </option>
          ))}
        </select>
      )}
      <p className="text-xs text-ink-soft">{t('consents.explanation')}</p>

      {/* A2, and the sharpest instance of it on this page: an unread consent
          list falls back to `granted: false` for every type, i.e. the screen
          states that nothing was consented to. A consent switch must never
          assert a legal fact it could not read, so the switches are not shown
          at all until the read succeeds. */}
      {consentsError ? (
        <ErrorBlock error={consentsError} onRetry={() => void refetchConsents()} />
      ) : (
      <div className="flex flex-col gap-2">
        {CONSENT_TYPES.map((type) => (
          <label key={type} className="flex items-center justify-between rounded-card border border-sand-200 p-3">
            <div>
              <p className="text-sm font-medium text-ink">{t(`consents.type.${type}.title`)}</p>
              <p className="text-xs text-ink-soft">{t(`consents.type.${type}.description`)}</p>
            </div>
            <input
              type="checkbox"
              checked={grantedByType.get(type) ?? false}
              disabled={toggleMutation.isPending}
              onChange={(e) => toggleMutation.mutate({ consentType: type, granted: e.target.checked })}
            />
          </label>
        ))}
      </div>
      )}
    </div>
  );
}

const FAQ_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5'];

function SupportTab() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  const submitMutation = useMutation({
    mutationFn: () => supportApi.submitRequest({ email, subject, message }),
    onSuccess: () => setSent(true),
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-sm font-medium text-ink">{t('support.faqTitle')}</h3>
        <div className="mt-2 flex flex-col gap-2">
          {FAQ_KEYS.map((key) => (
            <details key={key} className="rounded-card border border-sand-200 p-3">
              <summary className="cursor-pointer text-sm font-medium text-ink">{t(`support.faq.${key}`)}</summary>
              <p className="mt-2 text-xs text-ink-soft">{t(`support.faq.a${key.slice(1)}`)}</p>
            </details>
          ))}
        </div>
      </div>

      <div className="max-w-md">
        <h3 className="text-sm font-medium text-ink">{t('support.contactTitle')}</h3>
        {sent ? (
          <p className="mt-2 text-xs text-sage-600">{t('support.sentBody')}</p>
        ) : (
          <div className="mt-2 flex flex-col gap-3">
            <Input label={t('support.email')} type="email" onChange={(e) => setEmail(e.target.value)} />
            <Input label={t('support.subject')} onChange={(e) => setSubject(e.target.value)} />
            <textarea
              className="rounded-card border border-sand-200 px-3 py-2 text-sm"
              rows={4}
              placeholder={t('support.message')}
              onChange={(e) => setMessage(e.target.value)}
            />
            <Button
              onClick={() => submitMutation.mutate()}
              isLoading={submitMutation.isPending}
              disabled={!email || !subject || !message}
              className="w-fit"
            >
              {t('support.send')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function AccountTab() {
  const { t } = useTranslation();
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => settingsApi.deleteAccount(password),
    onSuccess: () => {
      window.location.href = '/login';
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="flex max-w-md flex-col gap-4">
      <div className="rounded-card border border-brick-100 bg-brick-100/40 p-4">
        <p className="text-sm font-medium text-brick-600">{t('deleteAccount.warningTitle')}</p>
        <p className="mt-1 text-xs text-brick-500">{t('deleteAccount.warningBody')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        {t('deleteAccount.confirmCheckbox')}
      </label>
      <Input
        type="password"
        label={t('deleteAccount.currentPassword')}
        disabled={!confirmed}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <p className="text-xs text-brick-600">{error}</p>}
      <Button
        variant="danger"
        disabled={!confirmed || !password}
        isLoading={deleteMutation.isPending}
        onClick={() => deleteMutation.mutate()}
        className="w-fit"
      >
        {t('deleteAccount.submit')}
      </Button>
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
        {(['profile', 'family', 'billing', 'consents', 'support', 'account'] as Tab[]).map((tabKey) => (
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
        {tab === 'consents' && <ConsentsTab />}
        {tab === 'support' && <SupportTab />}
        {tab === 'account' && <AccountTab />}
      </div>
    </Card>
  );
}
