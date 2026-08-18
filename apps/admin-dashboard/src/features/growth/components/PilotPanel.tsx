import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { COUNTRY_CODES, type CountryCode } from '../api/types';
import { useGrowthSettings } from '../api/useGrowthQueries';
import { composePilotStatus, pilotEnrollmentGap } from '../api/adapters';
import { AsyncBoundary, ComposedFromNote, FigureGridSkeleton, GapBlock, RefetchingOverlay } from './AsyncState';

/**
 * THE CONTROLLED PILOT — `GET /admin/growth/settings`
 * (`growth-admin.controller.ts:443`).
 *
 * What is real here: the gate's CONFIGURATION. `pilot.enabled`,
 * `pilot.countries` and `pilot.cohortId` are the exact three rows
 * `PilotEnrollmentService` reads when it decides whether a registration may
 * proceed, so this panel and the gate cannot disagree.
 *
 * What is NOT here, and is declared instead of guessed: invited and activated
 * family counts. Those rows exist in the database but no controller reads
 * them out (see `pilotEnrollmentGap`).
 *
 * Status is never a raw enum: the operator sees a sentence, and each state
 * carries a glyph as well as a colour so it survives greyscale and
 * colour-vision deficiency.
 */
export function PilotPanel() {
  const { t } = useTranslation();
  const settings = useGrowthSettings();
  const gap = pilotEnrollmentGap();

  return (
    <section aria-labelledby="pilot-panel" className="rounded-card border border-sand-200 bg-white p-5 shadow-quiet">
      <header className="mb-3">
        <h3 id="pilot-panel" className="font-display text-lg text-ink">
          {t('growth.pilot.title')}
        </h3>
        <p className="mt-1 text-sm text-ink-soft">{t('growth.pilot.subtitle')}</p>
      </header>

      <AsyncBoundary
        isLoading={settings.isLoading}
        error={settings.error}
        onRetry={() => void settings.refetch()}
        skeleton={<FigureGridSkeleton count={2} />}
      >
        <RefetchingOverlay isFetching={settings.isFetching}>
          <div className="grid gap-3 lg:grid-cols-2">
            {COUNTRY_CODES.map((country) => (
              <CountryPilotCard key={country} country={country} settings={settings.data} />
            ))}
          </div>
          <ComposedFromNote endpoints={['GET /admin/growth/settings']} />
        </RefetchingOverlay>
      </AsyncBoundary>

      <div className="mt-4">
        <GapBlock gap={gap.gap} />
      </div>
    </section>
  );
}

function CountryPilotCard({
  country,
  settings,
}: {
  country: CountryCode;
  settings: ReturnType<typeof useGrowthSettings>['data'];
}) {
  const { t } = useTranslation();
  const status = composePilotStatus(settings, country).data;

  return (
    <article className="rounded-card border border-sand-200 bg-sand-50/60 p-4">
      <h4 className="font-medium text-ink">{t(`growth.country.${country}`)}</h4>
      <ul className="mt-2 flex flex-col gap-1.5 text-sm">
        <StatusLine
          state={status.enabled}
          onLabel={t('growth.pilot.enabled')}
          offLabel={t('growth.pilot.disabled')}
          unknownLabel={t('growth.pilot.unknown')}
        />
        <StatusLine
          state={status.inPilot}
          onLabel={t('growth.pilot.inPilot')}
          offLabel={t('growth.pilot.notInPilot')}
          unknownLabel={t('growth.pilot.unknown')}
        />
        <StatusLine
          state={status.cohortConfigured}
          onLabel={t('growth.pilot.cohortConfigured')}
          offLabel={t('growth.pilot.cohortMissing')}
          unknownLabel={t('growth.pilot.unknown')}
        />
      </ul>
    </article>
  );
}

/**
 * `null` is its own state and reads "not configured" — never "off". A
 * missing settings row means nobody has decided, and rendering that as
 * «متوقّفة» would put a decision in someone's mouth.
 */
function StatusLine({
  state,
  onLabel,
  offLabel,
  unknownLabel,
}: {
  state: boolean | null;
  onLabel: string;
  offLabel: string;
  unknownLabel: string;
}) {
  const glyph = state === null ? '◌' : state ? '●' : '○';
  const label = state === null ? unknownLabel : state ? onLabel : offLabel;
  const tone = state === null ? 'text-ink-soft' : state ? 'text-guardian-900' : 'text-ink-soft';

  return (
    <li className={`flex items-center gap-2 ${tone}`}>
      <span aria-hidden="true" className="text-xs">
        {glyph}
      </span>
      <span>{label}</span>
    </li>
  );
}
