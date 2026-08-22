import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { AsyncBoundary } from '../../../shared/components/AsyncState';
import { platformOpsApi, type PlanDefinition, type PlanTier } from '../api/platformOpsApi';

const TIERS: PlanTier[] = ['FREE', 'BASIC', 'PREMIUM', 'FAMILY', 'ENTERPRISE'];

/**
 * ===========================================================================
 * THE PLAN CATALOGUE EDITOR — the table nothing has ever written.
 * ===========================================================================
 *
 * `plan_definitions` is described in the schema as «seeded once, admin-editable
 * later». No migration seeds it and, until this screen, nothing edited it. On
 * every database built from the migration history it is EMPTY, and an empty
 * catalogue is not a cosmetic state: `hasFeature` falls back to the household's
 * tier, looks it up here, finds nothing, and answers false. Every paid feature
 * is locked for every household — including whatever the FREE tier was meant to
 * include, because that list lives in this table too.
 *
 * NOTHING HERE IS PRE-FILLED WITH A PRICE. A default of «PREMIUM = 4999 EGP»
 * would put a number nobody chose into the one place the whole commercial side
 * reads it from, and the first person to notice would be a customer. The form
 * starts empty and says what the empty catalogue costs.
 *
 * THERE IS NO DELETE, deliberately: existing subscriptions point at a tier, and
 * removing its row would leave them pointing at nothing. `isActive: false`
 * retires a plan from the customer-facing list while every reference stays
 * valid.
 */
export function PlanCataloguePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const catalogue = useQuery({ queryKey: ['plan-catalogue'], queryFn: platformOpsApi.plans });
  const [editing, setEditing] = useState<PlanTier | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const upsert = useMutation({
    mutationFn: (plan: Omit<PlanDefinition, 'id'>) => platformOpsApi.upsertPlan(plan),
    onSuccess: (plan) => {
      setMessage(`${t('catalogue.saved')} — ${plan.tier}`);
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['plan-catalogue'] });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const existing = (tier: PlanTier) => catalogue.data?.plans.find((plan) => plan.tier === tier);

  return (
    <section>
      <header>
        <h1>{t('catalogue.title')}</h1>
        <p>{t('catalogue.intro')}</p>
      </header>

      <AsyncBoundary
        isLoading={catalogue.isLoading}
        error={catalogue.isError ? (catalogue.error as Error) : null}
        onRetry={() => catalogue.refetch()}
      >
        {catalogue.data?.isEmpty ? (
          // Stated as a consequence, not as "no data": an empty catalogue is
          // the reason nothing paid works, and an operator reading "no plans"
          // would not know that.
          <p role="alert">{t('catalogue.emptyConsequence')}</p>
        ) : null}

        <table>
          <thead>
            <tr>
              <th scope="col">{t('catalogue.tier')}</th>
              <th scope="col">{t('catalogue.name')}</th>
              <th scope="col">{t('catalogue.price')}</th>
              <th scope="col">{t('catalogue.interval')}</th>
              <th scope="col">{t('catalogue.features')}</th>
              <th scope="col">{t('catalogue.active')}</th>
              <th scope="col">{t('catalogue.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map((tier) => {
              const plan = existing(tier);
              return (
                <tr key={tier}>
                  <td>{tier}</td>
                  <td>{plan?.name ?? t('catalogue.undefined')}</td>
                  <td>
                    {plan ? `${(plan.priceCents / 100).toFixed(2)} ${plan.currency}` : '—'}
                  </td>
                  <td>{plan ? `${plan.billingIntervalMonths} ${t('catalogue.months')}` : '—'}</td>
                  <td>{plan?.features.join(', ') || '—'}</td>
                  <td>{plan ? (plan.isActive ? t('catalogue.yes') : t('catalogue.no')) : '—'}</td>
                  <td>
                    <button type="button" onClick={() => setEditing(tier)}>
                      {plan ? t('catalogue.edit') : t('catalogue.define')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </AsyncBoundary>

      {editing ? (
        <PlanForm
          tier={editing}
          plan={existing(editing)}
          availableFeatures={catalogue.data?.availableFeatures ?? []}
          pending={upsert.isPending}
          onCancel={() => setEditing(null)}
          onSubmit={(plan) => upsert.mutate(plan)}
        />
      ) : null}

      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

function PlanForm({
  tier,
  plan,
  availableFeatures,
  pending,
  onCancel,
  onSubmit,
}: {
  tier: PlanTier;
  plan: PlanDefinition | undefined;
  availableFeatures: string[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (plan: Omit<PlanDefinition, 'id'>) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('EGP');
  const [months, setMonths] = useState(1);
  const [features, setFeatures] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(true);

  // Re-seeded when the tier changes so opening PREMIUM after BASIC does not
  // show BASIC's values under PREMIUM's heading.
  useEffect(() => {
    setName(plan?.name ?? '');
    setPrice(plan ? String(plan.priceCents / 100) : '');
    setCurrency(plan?.currency ?? 'EGP');
    setMonths(plan?.billingIntervalMonths ?? 1);
    setFeatures(plan?.features ?? []);
    setIsActive(plan?.isActive ?? true);
  }, [tier, plan]);

  const priceCents = Math.round(Number(price) * 100);
  const valid = name.trim().length > 0 && Number.isFinite(priceCents) && priceCents >= 0 && /^[A-Z]{3}$/.test(currency);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ tier, name: name.trim(), priceCents, currency, billingIntervalMonths: months, features, isActive });
      }}
    >
      <h2>{tier}</h2>

      <label htmlFor="plan-name">{t('catalogue.name')}</label>
      <input id="plan-name" value={name} onChange={(event) => setName(event.target.value)} />

      {/* Entered in whole currency units and sent in cents. The backend field
          is `priceCents` precisely so 4999 can never be read as four thousand
          nine hundred and ninety-nine pounds; the form keeps that boundary. */}
      <label htmlFor="plan-price">{t('catalogue.priceInput')}</label>
      <input
        id="plan-price"
        type="number"
        min={0}
        step="0.01"
        value={price}
        onChange={(event) => setPrice(event.target.value)}
      />

      <label htmlFor="plan-currency">{t('catalogue.currency')}</label>
      <input
        id="plan-currency"
        value={currency}
        maxLength={3}
        onChange={(event) => setCurrency(event.target.value.toUpperCase())}
      />

      <label htmlFor="plan-months">{t('catalogue.interval')}</label>
      <input
        id="plan-months"
        type="number"
        min={1}
        max={36}
        value={months}
        onChange={(event) => setMonths(Number(event.target.value))}
      />

      <fieldset>
        <legend>{t('catalogue.features')}</legend>
        {availableFeatures.map((feature) => (
          <label key={feature}>
            <input
              type="checkbox"
              checked={features.includes(feature)}
              onChange={(event) =>
                setFeatures((current) =>
                  event.target.checked ? [...current, feature] : current.filter((item) => item !== feature),
                )
              }
            />
            {feature}
          </label>
        ))}
      </fieldset>

      <label>
        <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
        {t('catalogue.activeLabel')}
      </label>

      <button type="submit" disabled={!valid || pending}>
        {t('catalogue.save')}
      </button>
      <button type="button" onClick={onCancel}>
        {t('common.close')}
      </button>
    </form>
  );
}
