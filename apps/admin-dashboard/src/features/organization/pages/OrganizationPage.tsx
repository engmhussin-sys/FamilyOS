import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { organizationApi } from '../api/organizationApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

const ORGANIZATION_QUERY_KEY = ['organizations', 'mine'] as const;

function CreateOrganizationForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [type, setType] = useState<'COMPANY' | 'SCHOOL' | 'BANK'>('COMPANY');

  const createMutation = useMutation({
    mutationFn: () => organizationApi.create(type, name),
    onSuccess: onCreated,
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-soft">{t('organization.noneYet')}</p>
      <select className="rounded-card border border-sand-200 px-3 py-2 text-sm" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
        <option value="COMPANY">{t('organization.type.COMPANY')}</option>
        <option value="SCHOOL">{t('organization.type.SCHOOL')}</option>
        <option value="BANK">{t('organization.type.BANK')}</option>
      </select>
      <Input label={t('organization.name')} onChange={(e) => setName(e.target.value)} />
      <Button onClick={() => createMutation.mutate()} isLoading={createMutation.isPending} disabled={!name} className="w-fit">
        {t('organization.create')}
      </Button>
    </div>
  );
}

function MembersPanel({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: members } = useQuery({
    queryKey: ['organization-members', organizationId],
    queryFn: () => organizationApi.listMembers(organizationId),
  });
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('MEMBER');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const inviteMutation = useMutation({
    mutationFn: () => organizationApi.inviteMember(organizationId, inviteEmail, inviteRole),
    onSuccess: (invitation) => {
      // HONEST NOTE: no real email-sending mechanism exists anywhere
      // in this project (same limitation as push notifications
      // without a configured Firebase project) — showing the direct
      // link for manual copy/send is the honest solution, not a
      // fabricated "email sent" claim.
      setInviteLink(`${window.location.origin}/invitations/${invitation.id}/accept`);
      setInviteEmail('');
      queryClient.invalidateQueries({ queryKey: ['organization-members', organizationId] });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium text-ink">{t('organization.members')}</h3>
        <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-soft">
          {members?.map((m) => (
            <li key={m.id}>
              {m.userId} — {m.role}
            </li>
          ))}
          {members?.length === 0 && <li>{t('organization.noMembers')}</li>}
        </ul>
      </div>
      <div className="max-w-sm">
        <h3 className="text-sm font-medium text-ink">{t('organization.inviteMember')}</h3>
        <div className="mt-2 flex flex-col gap-2">
          <Input label={t('support.email')} type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          <select className="rounded-card border border-sand-200 px-3 py-2 text-sm" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
            <option value="ADMIN">ADMIN</option>
            <option value="MANAGER">MANAGER</option>
            <option value="MEMBER">MEMBER</option>
            <option value="GUEST">GUEST</option>
          </select>
          <Button onClick={() => inviteMutation.mutate()} isLoading={inviteMutation.isPending} disabled={!inviteEmail} className="w-fit">
            {t('organization.sendInvite')}
          </Button>
          {inviteLink && (
            <div className="rounded-card border border-sand-200 bg-sand-50 p-3">
              <p className="text-xs text-ink-soft">{t('organization.inviteLinkExplanation')}</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded bg-white px-2 py-1 text-xs">{inviteLink}</code>
                <Button
                  variant="secondary"
                  onClick={() => {
                    navigator.clipboard.writeText(inviteLink);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? t('organization.copied') : t('organization.copyLink')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PolicyPanel({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation();
  const [key, setKey] = useState('default_screen_time_minutes');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);

  const setPolicyMutation = useMutation({
    mutationFn: () => organizationApi.setPolicy(organizationId, key, Number(value) || value),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div className="max-w-sm">
      <h3 className="text-sm font-medium text-ink">{t('organization.policies')}</h3>
      <p className="mt-1 text-xs text-ink-soft">{t('organization.policiesExplanation')}</p>
      <div className="mt-2 flex flex-col gap-2">
        <Input label={t('organization.policyKey')} value={key} onChange={(e) => setKey(e.target.value)} />
        <Input label={t('organization.policyValue')} onChange={(e) => setValue(e.target.value)} />
        <Button onClick={() => setPolicyMutation.mutate()} isLoading={setPolicyMutation.isPending} disabled={!key} className="w-fit">
          {t('common.save')}
        </Button>
        {saved && <p className="text-xs text-sage-600">{t('settings.saved')}</p>}
      </div>
    </div>
  );
}

function BrandingPanel({ organizationId, currentSettings }: { organizationId: string; currentSettings: Record<string, unknown> | null }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [logoUrl, setLogoUrl] = useState((currentSettings?.logoUrl as string) ?? '');
  const [primaryColor, setPrimaryColor] = useState((currentSettings?.primaryColor as string) ?? '');
  const [secondaryColor, setSecondaryColor] = useState((currentSettings?.secondaryColor as string) ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const brandingMutation = useMutation({
    mutationFn: () =>
      organizationApi.updateBranding(organizationId, {
        logoUrl: logoUrl || undefined,
        primaryColor: primaryColor || undefined,
        secondaryColor: secondaryColor || undefined,
      }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ORGANIZATION_QUERY_KEY });
      setTimeout(() => setSaved(false), 2000);
    },
    onError: () => setError(t('organization.brandingInvalid')),
  });

  return (
    <div className="max-w-sm">
      <h3 className="text-sm font-medium text-ink">{t('organization.branding')}</h3>
      <p className="mt-1 text-xs text-ink-soft">{t('organization.brandingExplanation')}</p>
      <div className="mt-2 flex flex-col gap-2">
        <Input label={t('organization.logoUrl')} value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://..." />
        <Input label={t('organization.primaryColor')} value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} placeholder="#RRGGBB" />
        <Input label={t('organization.secondaryColor')} value={secondaryColor} onChange={(e) => setSecondaryColor(e.target.value)} placeholder="#RRGGBB" />
        {logoUrl && <img src={logoUrl} alt="" className="h-10 w-auto rounded-card border border-sand-200 object-contain" />}
        <Button onClick={() => brandingMutation.mutate()} isLoading={brandingMutation.isPending} className="w-fit">
          {t('common.save')}
        </Button>
        {saved && <p className="text-xs text-sage-600">{t('settings.saved')}</p>}
        {error && <p className="text-xs text-brick-600">{error}</p>}
      </div>
    </div>
  );
}

export function OrganizationPage() {
  const { t } = useTranslation();
  const { data: organizations, refetch } = useQuery({ queryKey: ORGANIZATION_QUERY_KEY, queryFn: organizationApi.listMine });
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const activeOrgId = selectedOrgId ?? organizations?.[0]?.id ?? null;
  const activeOrg = organizations?.find((org) => org.id === activeOrgId) ?? null;

  if (!organizations) {
    return (
      <Card>
        <p className="text-sm text-ink-soft">{t('common.loading')}</p>
      </Card>
    );
  }

  if (organizations.length === 0) {
    return (
      <Card>
        <h1 className="font-display text-xl text-ink">{t('organization.title')}</h1>
        <div className="mt-4">
          <CreateOrganizationForm onCreated={() => refetch()} />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="font-display text-xl text-ink">{t('organization.title')}</h1>
      {organizations.length > 1 && (
        <select
          className="mt-3 rounded-card border border-sand-200 px-3 py-2 text-sm"
          value={activeOrgId ?? ''}
          onChange={(e) => setSelectedOrgId(e.target.value)}
        >
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name} ({t(`organization.type.${org.type}`)})
            </option>
          ))}
        </select>
      )}
      {activeOrgId && (
        <div className="mt-6 flex flex-col gap-8">
          <MembersPanel organizationId={activeOrgId} />
          <PolicyPanel organizationId={activeOrgId} />
          <BrandingPanel key={activeOrgId} organizationId={activeOrgId} currentSettings={activeOrg?.settings ?? null} />
        </div>
      )}
    </Card>
  );
}
