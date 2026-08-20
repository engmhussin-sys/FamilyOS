/**
 * B3 — THE GLOBAL ERROR CONTRACT: the vocabulary half.
 *
 * PA-B-021 proved at runtime that `{ code, messageAr }` bodies were erased
 * before they ever reached a client, so every non-punitive Arabic sentence F4
 * wrote was unreachable. Fixing the filter alone would surface the codes that
 * ALREADY carry Arabic — it would leave the other half of the surface (58
 * `throw new XException('plain english')` sites, plus `{ code, errors }` bodies
 * that carry no prose at all) still answering a child in English.
 *
 * THIS FILE IS THE FALLBACK, NOT THE SOURCE OF TRUTH.
 *
 *   1. A `messageAr` thrown at the call site ALWAYS wins. Nothing here
 *      overrides it. That is deliberate: `program-rules.ts` interpolates real
 *      counters into its sentences ("أكملت هذا البرنامج 2 مرة اليوم") and a
 *      static table could never reproduce that. Duplicating those strings here
 *      would only create two copies free to drift.
 *   2. If a body carries a `code` but no `messageAr`, CODE_CATALOGUE supplies
 *      one.
 *   3. If it carries neither, STATUS_FALLBACK supplies both a code and a
 *      message, so that EVERY error response — including ones thrown by Nest
 *      itself, by a guard, or by the ValidationPipe — has a machine-readable
 *      `code` and an Arabic sentence. There is no path to a response without
 *      them; that is what makes the regression impossible to reintroduce
 *      silently.
 *
 * NON-PUNITIVE (CONTEXT §3 principle 7). Every Arabic sentence below is a
 * statement of fact plus a way forward. There is no «ممنوع», no «تجاوزت», no
 * «حظر». A 403 says "you do not have permission for this action", not "you are
 * forbidden"; a 429 says "wait a little and try again", not "you did too much".
 */

export interface ErrorCatalogueEntry {
  /** English, for backward compatibility with every existing consumer. */
  readonly messageEn: string;
  /** Arabic, the string a real user actually reads. */
  readonly messageAr: string;
}

export interface StatusFallback extends ErrorCatalogueEntry {
  readonly code: string;
}

/**
 * Per-status defaults. Reached when an exception carries no `code` at all —
 * which is every `throw new NotFoundException('Habit not found')` in the
 * codebase today, and everything Nest's own guards and pipes throw.
 */
export const STATUS_FALLBACK: Readonly<Record<number, StatusFallback>> = Object.freeze({
  400: {
    code: 'BAD_REQUEST',
    messageEn: 'The request could not be accepted as sent.',
    messageAr: 'تعذّر قبول هذا الطلب. راجع البيانات ثم أعد المحاولة.',
  },
  401: {
    code: 'UNAUTHENTICATED',
    messageEn: 'Authentication is required for this request.',
    messageAr: 'انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.',
  },
  403: {
    code: 'UNAUTHORIZED_ACTION',
    messageEn: 'You do not have permission to perform this action.',
    messageAr: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.',
  },
  404: {
    code: 'NOT_FOUND',
    messageEn: 'The requested resource was not found.',
    messageAr: 'لم نجد ما تبحث عنه.',
  },
  409: {
    code: 'CONFLICT',
    messageEn: 'This action has already been done, or is not available right now.',
    messageAr: 'هذا الإجراء تمّ بالفعل، أو لم يعد متاحًا الآن.',
  },
  413: {
    code: 'PAYLOAD_TOO_LARGE',
    messageEn: 'The request payload is larger than allowed.',
    messageAr: 'حجم البيانات المُرسلة أكبر من المسموح. أرسلها على دفعات أصغر.',
  },
  422: {
    code: 'UNPROCESSABLE_ENTITY',
    messageEn: 'The request was understood but could not be processed with this data.',
    messageAr: 'فهمنا طلبك، لكن تعذّر تنفيذه بهذه البيانات.',
  },
  429: {
    code: 'RATE_LIMITED',
    messageEn: 'Too many requests. Please wait a moment and try again.',
    messageAr: 'عدد المحاولات كبير الآن. انتظر قليلًا ثم أعد المحاولة.',
  },
  500: {
    code: 'INTERNAL_ERROR',
    messageEn: 'An internal error occurred. Please try again or contact support with this reference.',
    messageAr: 'حدث خطأ غير متوقّع عندنا. حاول مرة أخرى، وإن تكرّر أرسل لنا رقم الطلب.',
  },
  502: {
    code: 'UPSTREAM_ERROR',
    messageEn: 'An upstream service returned an invalid response.',
    messageAr: 'خدمة خارجية لم تستجب كما ينبغي. حاول بعد قليل.',
  },
  503: {
    code: 'SERVICE_UNAVAILABLE',
    messageEn: 'The service is temporarily unavailable. Please try again shortly.',
    messageAr: 'الخدمة غير متاحة مؤقتًا. حاول بعد قليل.',
  },
  504: {
    code: 'UPSTREAM_TIMEOUT',
    messageEn: 'An upstream service took too long to respond.',
    messageAr: 'استغرقت الاستجابة وقتًا أطول من المعتاد. حاول مرة أخرى.',
  },
});

/** The catch-all when a status has no entry above. */
export const UNKNOWN_STATUS_FALLBACK: StatusFallback = Object.freeze({
  code: 'REQUEST_FAILED',
  messageEn: 'The request could not be completed.',
  messageAr: 'تعذّر إتمام هذا الطلب. حاول مرة أخرى.',
});

/**
 * Codes that are thrown WITHOUT Arabic prose today, plus the shared vocabulary
 * the mobile and admin clients switch on. A code thrown WITH `messageAr`
 * (everything in `program-rules.ts`, `achievement.service.ts`,
 * `reward-payout.service.ts`, …) is deliberately absent: its own sentence wins
 * and listing it here would fork the wording.
 */
export const CODE_CATALOGUE: Readonly<Record<string, ErrorCatalogueEntry>> = Object.freeze({
  // --- shared reward/achievement vocabulary -------------------------------
  REWARD_ALREADY_GRANTED: {
    messageEn: 'This reward has already been counted.',
    messageAr: 'تم احتساب هذه المكافأة بالفعل.',
  },
  REWARD_LIMIT_REACHED: {
    messageEn: 'You have reached today’s limit for this reward.',
    messageAr: 'لقد وصلت إلى الحد المسموح من هذه المكافأة اليوم.',
  },
  ACHIEVEMENT_NOT_VERIFIED: {
    messageEn: 'This achievement has not been verified yet.',
    messageAr: 'لم يتم التحقق من الإنجاز بعد.',
  },
  UNAUTHORIZED_ACTION: {
    messageEn: 'You do not have permission to perform this action.',
    messageAr: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.',
  },

  // --- DTO / spec validation ---------------------------------------------
  VALIDATION_FAILED: {
    messageEn: 'Some of the submitted fields could not be accepted.',
    messageAr: 'تعذّر قبول بعض الحقول المُرسلة. راجعها ثم أعد المحاولة.',
  },
  // reward-program.service.ts:73 — body is `{ code, errors }` with no prose.
  TARGET_SPEC_INVALID: {
    messageEn: 'The activity target is incomplete or invalid.',
    messageAr: 'تفاصيل الهدف غير مكتملة أو غير صحيحة. راجعها ثم أعد الحفظ.',
  },
  // reward-program.service.ts:78 — same shape.
  REWARD_SPEC_INVALID: {
    messageEn: 'The reward definition is incomplete or invalid.',
    messageAr: 'تفاصيل المكافأة غير مكتملة أو غير صحيحة. راجعها ثم أعد الحفظ.',
  },

  // --- events batch (F3) — thrown with an English `message`, no Arabic ----
  EVENT_BATCH_TOO_LARGE: {
    messageEn: 'The batch carries more events than a single request may contain.',
    messageAr: 'عدد الأحداث في هذه الدفعة أكبر من المسموح. سنرسلها على دفعات أصغر.',
  },
  DEVICE_CLOCK_SKEW: {
    messageEn: 'The device clock differs from the server clock by too much.',
    messageAr: 'ساعة الجهاز غير مضبوطة. فعّل ضبط الوقت تلقائيًا ثم أعد المحاولة.',
  },

  // --- infrastructure -----------------------------------------------------
  INTERNAL_ERROR: {
    messageEn: STATUS_FALLBACK[500].messageEn,
    messageAr: STATUS_FALLBACK[500].messageAr,
  },
  SERVICE_UNAVAILABLE: {
    messageEn: STATUS_FALLBACK[503].messageEn,
    messageAr: STATUS_FALLBACK[503].messageAr,
  },
});

export function fallbackForStatus(status: number): StatusFallback {
  return STATUS_FALLBACK[status] ?? UNKNOWN_STATUS_FALLBACK;
}

export function catalogueFor(code: string | undefined): ErrorCatalogueEntry | undefined {
  return code ? CODE_CATALOGUE[code] : undefined;
}
