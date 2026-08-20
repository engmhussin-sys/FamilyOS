/**
 * ============================================================================
 * PARTNER CAMPAIGNS — THE TWO SENTENCES A PARENT READS AFTER REDEEMING A CODE.
 * ============================================================================
 *
 * WHAT WAS THERE, MEASURED. Two English literals built inline in
 * `campaign-redemption.service.ts`:
 *
 *   `Your trial has been extended by 30 day(s), now ending 2026-09-01.`
 *   `A 20% discount has been applied — it will be used automatically the next
 *    time you subscribe or renew.`
 *
 * Neither was a raw enum and neither had an unsubstituted placeholder, so every
 * generic leak check passed them. They were simply the wrong language on the
 * wrong screen: `redeem_code_screen.dart` DELIBERATELY prefers the server's
 * sentence over its own localised fallback (it is the only thing that knows the
 * real numbers), and documents that it renders it verbatim. So every SUCCESSFUL
 * redemption in Cairo and Riyadh ended in an English paragraph inside an RTL
 * success box — the failure mode that is invisible to a linter and obvious to a
 * user.
 *
 * `day(s)` deserves its own note: it is not English, it is untranslated
 * developer shorthand for "I did not want to think about plurals". Arabic has
 * more cases than English does, not fewer, so they are handled below rather
 * than avoided.
 *
 * THE DATE. `newTrialEndsAt.toISOString().split('T')[0]` was the UTC class
 * `common/time/family-date.ts` exists to have removed — for a Cairo family a
 * trial ending at 01:00 local on the 1st was announced as the 31st. The
 * business date is decided by `FamilyDateService` from `Family.timezone` before
 * it ever reaches this file; what is here only renders a `YYYY-MM-DD` that has
 * already been resolved on the family's own calendar.
 *
 * DIGITS AND THE PERCENT SIGN. Arabic-Indic digits, for the same `PF-E-002`
 * reason `notification-copy.ts` and `life-timeline-copy.ts` give — Arabic prose
 * with Latin numerals reads as a translation. `٪` (U+066A) for the same reason:
 * `20%` in an RTL sentence renders with the sign on the wrong side of the
 * number in some engines, and the Arabic sign has no such ambiguity. Each copy
 * module keeps its own three-line digit table, as those two do; a shared
 * import between unrelated domains would be the only coupling either has.
 */

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

export function formatArabicNumber(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)]);
}

/**
 * The month names EG and SA actually use. Deliberately NOT the Levantine set
 * (كانون الثاني / شباط …): the two launch markets both read the
 * يناير/فبراير/مارس series, and picking the other one would be correct Arabic
 * that no parent in either market writes.
 */
const MONTHS_AR = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];

/**
 * `2026-09-01` -> «١ سبتمبر ٢٠٢٦».
 *
 * A BUSINESS DATE IN, never an instant: the caller has already asked
 * `FamilyDateService` which calendar day this is for this family, so there is
 * no timezone left to get wrong here and none is accepted. An input that is not
 * `YYYY-MM-DD` is returned with its digits converted and nothing invented,
 * because a success screen is the wrong place to throw.
 */
export function formatArabicBusinessDate(businessDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (!match) return formatArabicNumber(businessDate);
  const [, year, month, day] = match;
  const monthAr = MONTHS_AR[Number(month) - 1];
  if (!monthAr) return formatArabicNumber(businessDate);
  return `${formatArabicNumber(Number(day))} ${monthAr} ${formatArabicNumber(year)}`;
}

/**
 * ARABIC DOES NOT HAVE «day(s)». It has four cases for a counted noun, and
 * getting them wrong is the thing that makes machine-translated Arabic
 * recognisable at a glance:
 *
 *   1        مفرد            «يومًا واحدًا»
 *   2        مثنى            «يومين»
 *   3–10     جمع قلة         «٥ أيام»
 *   11+      تمييز مفرد منصوب «٣٠ يومًا»
 *
 * `0` cannot reach here — `readExtraDays` rejects any value that is not a
 * positive integer — but it is given the 11+ form rather than left undefined,
 * because a sentence that reads slightly formally beats a sentence with
 * `undefined` in it.
 */
export function arabicDayCount(days: number): string {
  if (days === 1) return 'يومًا واحدًا';
  if (days === 2) return 'يومين';
  if (days >= 3 && days <= 10) return `${formatArabicNumber(days)} أيام`;
  return `${formatArabicNumber(days)} يومًا`;
}

/**
 * THE TWO SENTENCES. Both are addressed to the parent in the singular («باقتك»,
 * «اشتراكك»), which is the register the rest of the parent surface uses, and
 * both end in what happens next rather than in what was done — a success
 * message that does not say what changed is a receipt, not an answer.
 */
export const CAMPAIGN_COPY_AR = Object.freeze({
  /** @param trialEndsOn a business date (`YYYY-MM-DD`) on the FAMILY's calendar. */
  trialExtended: (extraDays: number, trialEndsOn: string): string =>
    `تم تمديد فترتك التجريبية ${arabicDayCount(extraDays)}، وتستمر حتى ${formatArabicBusinessDate(trialEndsOn)}.`,

  discountApplied: (discountPercent: number): string =>
    `تم تفعيل خصم ${formatArabicNumber(discountPercent)}٪ على اشتراكك، وسيُطبَّق تلقائيًا عند اشتراكك أو تجديدك القادم.`,
});
