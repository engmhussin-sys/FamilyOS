import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import { COUNTRY_CURRENCY } from '../lib/format';
import type { Channel, CountryCode, CreateCampaignInput } from '../api/types';

/**
 * Campaign create / edit.
 *
 * `budgetMinor`, `targetUsers` and `targetPaidUsers` are required here for
 * the same reason they are NOT NULL columns server-side: a campaign with no
 * budget and no declared target cannot exist, and letting one be created
 * and "filled in later" is how a channel ends up with an unfalsifiable CAC.
 *
 * The budget is entered in MAJOR units and converted once, on submit — an
 * operator typing 50000 meaning fifty thousand pounds should not have to
 * remember the storage representation, and every intermediate value staying
 * an integer is what keeps the conversion exact.
 */

const MINOR_UNIT_SCALE = 100;

interface CampaignFormProps {
  country: CountryCode;
  channels: Channel[];
  onSubmit: (input: CreateCampaignInput) => void;
  isSaving?: boolean;
}

export function CampaignForm({ country, channels, onSubmit, isSaving }: CampaignFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<Channel>(channels[0] ?? 'ORGANIC');
  const [budgetMajor, setBudgetMajor] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [targetUsers, setTargetUsers] = useState('');
  const [targetPaidUsers, setTargetPaidUsers] = useState('');

  const currency = COUNTRY_CURRENCY[country];
  const isValid =
    name.trim().length > 0 &&
    Number(budgetMajor) > 0 &&
    Number(targetUsers) > 0 &&
    Number(targetPaidUsers) > 0 &&
    startsAt.length > 0 &&
    endsAt.length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!isValid) return;
    onSubmit({
      name: name.trim(),
      channel,
      countryCode: country,
      currencyCode: currency,
      budgetMinor: Math.round(Number(budgetMajor) * MINOR_UNIT_SCALE),
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      targetUsers: Number(targetUsers),
      targetPaidUsers: Number(targetPaidUsers),
      utmCampaign: name.trim(),
    });
  }

  return (
    <form onSubmit={submit} className="rounded-card border border-sand-200 bg-white p-5 shadow-quiet">
      <h3 className="font-display text-base text-ink">{t('growth.acquisition.newCampaign')}</h3>
      <p className="mt-1 mb-4 text-xs text-ink-soft">{t('growth.acquisition.requiredBudgetHint')}</p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Input
          label={t('growth.acquisition.campaignName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="campaign-channel" className="text-sm font-medium text-ink">
            {t('growth.filter.channel')}
          </label>
          <select
            id="campaign-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as Channel)}
            className="rounded-card border border-sand-200 bg-white px-3.5 py-2.5 font-body text-sm text-ink"
          >
            {channels.map((option) => (
              <option key={option} value={option}>
                {t(`growth.channel.${option}`)}
              </option>
            ))}
          </select>
        </div>

        {/* The currency is in the label, not in a tooltip: the operator sees
            which market's money they are committing before they type it. */}
        <Input
          label={`${t('growth.acquisition.budget')} (${currency})`}
          type="number"
          min="0"
          step="0.01"
          value={budgetMajor}
          onChange={(e) => setBudgetMajor(e.target.value)}
          required
        />
        <Input
          label={t('growth.acquisition.startsAt')}
          type="date"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          required
        />
        <Input
          label={t('growth.acquisition.endsAt')}
          type="date"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
          required
        />
        <Input
          label={t('growth.acquisition.targetUsers')}
          type="number"
          min="1"
          value={targetUsers}
          onChange={(e) => setTargetUsers(e.target.value)}
          required
        />
        <Input
          label={t('growth.acquisition.targetPaidUsers')}
          type="number"
          min="1"
          value={targetPaidUsers}
          onChange={(e) => setTargetPaidUsers(e.target.value)}
          required
        />
      </div>

      <Button type="submit" className="mt-4" disabled={!isValid} isLoading={isSaving}>
        {t('growth.acquisition.createCampaign')}
      </Button>
    </form>
  );
}
