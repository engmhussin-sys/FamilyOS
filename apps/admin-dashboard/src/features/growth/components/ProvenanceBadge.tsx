import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { PROVENANCE } from '../lib/vizTokens';
import type { Provenance } from '../api/types';

/**
 * The text-side half of the FORECAST/TARGET/ACTUAL separation.
 *
 * The chart marks carry fill texture; this carries a word and a glyph, so
 * the distinction is legible in a table row that has no mark at all, and
 * survives a reader who never looks at a legend. Three channels, none of
 * them colour alone: glyph (● ◇ ◔) + label ("مقيس" / "هدف" / "توقّع") +
 * treatment (tinted chip / dashed outline chip / amber chip).
 */
export function ProvenanceBadge({ provenance, hint }: { provenance: Provenance; hint?: boolean }) {
  const { t } = useTranslation();
  const treatment = PROVENANCE[provenance];
  const hintKey = `growth.provenance.${provenance.toLowerCase()}Hint`;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-card px-2 py-0.5 text-[11px] font-medium ${treatment.badgeClass}`}
      title={hint ? t(hintKey) : undefined}
    >
      <span aria-hidden="true">{treatment.glyph}</span>
      {t(treatment.labelKey)}
    </span>
  );
}

/** The legend for the three, shown once per view rather than on every card. */
export function ProvenanceLegend() {
  const { t } = useTranslation();
  const order: Provenance[] = ['ACTUAL', 'TARGET', 'FORECAST'];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-sand-200 bg-sand-50 px-4 py-3">
      <span className="text-xs font-medium text-ink-soft">{t('growth.provenance.legend')}</span>
      {order.map((provenance) => (
        <span key={provenance} className="flex items-center gap-2">
          <ProvenanceBadge provenance={provenance} />
          <span className="text-xs text-ink-soft">{t(`growth.provenance.${provenance.toLowerCase()}Hint`)}</span>
        </span>
      ))}
    </div>
  );
}
