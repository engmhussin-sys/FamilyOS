/**
 * ============================================================================
 * GLOBAL SEARCH — THE LABELS A PARENT READS IN THE RESULT LIST.
 * ============================================================================
 *
 * WHAT WAS THERE, MEASURED. `search.service.ts` built its result rows inline:
 *
 *   subtitle: 'Child profile'
 *   subtitle: `Device · ${d.platform}`        ->  «Device · ANDROID»
 *   title:    d.deviceModel ?? d.platform     ->  «ANDROID» as the ROW TITLE
 *
 * The third is the serious one. `DevicePlatform` is a Prisma enum
 * (`schema.prisma:127`) — `ANDROID` / `IOS` — and `deviceModel` is nullable, so
 * a device paired before the client learned to report its model was listed to
 * the parent under the literal name of a database enum value. That is the rule
 * this codebase states plainly and had broken here: NO RAW ENUM MAY REACH A
 * USER. The first two were «only» the wrong language, in a product whose result
 * list is rendered right-to-left.
 *
 * WHY A MODULE FOR FOUR STRINGS. The same argument `life-timeline-copy.ts` and
 * `notification-copy.ts` make, and the reason this defect existed at all: copy
 * written inline next to the query that produced it is copy nobody reviews as
 * copy. It also puts the enum -> label table in ONE place, so a third
 * `DevicePlatform` value added tomorrow has exactly one file to be added to —
 * and until it is, it degrades to a generic Arabic noun rather than to its own
 * name.
 *
 * NO LATIN IN A LABEL, deliberately, including `iOS`. Half-transliterated
 * strings («جهاز iOS») are how a Latin token gets a foothold back into an RTL
 * line; «آبل» is the word, it covers iPhone and iPad — which `IOS` also does,
 * and «آيفون» would not — and it needs no bidi handling.
 */

/** The user-visible noun for a `DevicePlatform`. Not the enum, ever. */
const DEVICE_PLATFORM_LABEL_AR: Readonly<Record<string, string>> = Object.freeze({
  ANDROID: 'أندرويد',
  IOS: 'آبل',
});

export const SEARCH_COPY_AR = Object.freeze({
  /** The subtitle under a child's own name. */
  childProfile: (): string => 'ملف الطفل',

  /**
   * The subtitle under a device row: «جهاز · أندرويد».
   *
   * An UNKNOWN platform value collapses to the bare noun «جهاز» rather than
   * appending whatever string arrived — a table that fails open would put the
   * next enum value straight back on the screen, which is the defect.
   */
  deviceSubtitle: (platform: string): string => {
    const labelAr = DEVICE_PLATFORM_LABEL_AR[platform];
    return labelAr ? `جهاز · ${labelAr}` : 'جهاز';
  },

  /**
   * The TITLE of a device row when the device never reported a model.
   *
   * `deviceModel` — «Galaxy A54», «iPhone 13» — is the manufacturer's own
   * string and is shown verbatim when present, for the same reason
   * `life-timeline-copy.ts` interpolates a habit's own title verbatim:
   * rewriting somebody else's stored name is not this module's business. When
   * it is null the answer is a describable Arabic noun, never the enum.
   */
  deviceTitleFallback: (platform: string): string => {
    const labelAr = DEVICE_PLATFORM_LABEL_AR[platform];
    return labelAr ? `جهاز ${labelAr}` : 'جهاز غير محدّد الطراز';
  },
});
