import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { NO_DATA } from '../../growth/lib/format';

/**
 * THE ONE THING THIS DASHBOARD MAY PRINT INSTEAD OF A NUMBER IT DOES NOT
 * HAVE.
 *
 * The standing rule: a fabricated zero is a lie about the data. `format.ts`
 * already owns the glyph — `NO_DATA`, the em dash every `formatCount`,
 * `formatRate` and `formatMoneyMinor` returns for a `null` — and this
 * component is that glyph plus the WORDS, for the places where a lone dash
 * in a column of digits would be read as a rendering fault rather than as a
 * statement.
 *
 * It reuses `NO_DATA` rather than hard-coding a dash on purpose: the day the
 * absence glyph changes, it changes in one file and this follows.
 *
 * `reason` is REQUIRED. An absence with no explanation is indistinguishable
 * from a bug, and «why is this blank» is the only question it ever raises.
 */
export function UnmeasuredValue({ reason }: { reason: string }) {
  const { t } = useTranslation();
  return (
    <span className="text-ink-soft" title={reason}>
      {/* The dash carries no meaning a screen reader needs — the words beside
          it carry all of it — so it is hidden from the accessibility tree
          rather than announced as "em dash". */}
      <span aria-hidden="true">{NO_DATA}</span>{' '}
      <span className="text-xs">{t('notifications.decisions.unmeasured')}</span>
    </span>
  );
}
