/**
 * PHASE D (GROWTH) — EVERY BUSINESS NUMBER, IN ONE TABLE, EDITABLE WITHOUT A
 * DEPLOY.
 *
 * The brief's rule is absolute: budgets, targets, referral reward values,
 * qualification windows and alert thresholds are ADMIN-CONFIGURABLE and NEVER
 * hardcoded. This file is how that is enforced rather than promised.
 *
 * Every entry below is a DEFAULT and a SCHEMA, not a value. The value lives in
 * `growth_settings` (migration 0015); `GrowthSettingsService` reads it, falls
 * back to the default here when no row exists, and validates every write
 * against the bounds stated here — so an operator cannot set a referral reward
 * of 10,000 days by mistyping, and cannot set a churn alert threshold of 900%
 * that would never fire.
 *
 * WHY THE DEFAULTS ARE HERE AND NOT SEEDED-ONLY: a deployment with an empty
 * settings table must still boot and still behave. A missing configuration row
 * that silently disables fraud protection is a worse outcome than a documented
 * default that a HUMAN DECISION REQUIRED note asks someone to confirm.
 *
 * EVERY ENTRY MARKED `humanDecision: true` IS AN OPEN BUSINESS DECISION and is
 * reproduced verbatim in §«قرارات بشرية مطلوبة» of the Phase D Growth report.
 * The code does not pretend those numbers are settled; it picks a defensible
 * starting value, states who has to confirm it, and makes changing it an UPDATE.
 */

export type GrowthSettingValueType = 'INT' | 'RATE' | 'STRING' | 'BOOLEAN';

export interface GrowthSettingSchema {
  readonly key: string;
  readonly type: GrowthSettingValueType;
  /** Stored as text; parsed per `type`. */
  readonly defaultValue: string;
  readonly min: number | null;
  readonly max: number | null;
  readonly descriptionAr: string;
  /** True when the DEFAULT is a placeholder awaiting a business owner's sign-off. */
  readonly humanDecision: boolean;
}

export const GROWTH_SETTING_SCHEMAS: readonly GrowthSettingSchema[] = [
  // ---- referral -----------------------------------------------------------
  {
    key: 'referral.qualification.refundWindowDays',
    type: 'INT',
    defaultValue: '14',
    min: 0,
    max: 180,
    descriptionAr:
      'عدد الأيام التي يجب أن تمرّ على دفعة ناجحة قبل اعتبار الإحالة «مؤهَّلة». الغرض: ألّا تُدفع مكافأة على اشتراك يُستردّ بعدها.',
    humanDecision: true,
  },
  {
    key: 'referral.reward.kind',
    type: 'STRING',
    defaultValue: 'SUBSCRIPTION_CREDIT_DAYS',
    min: null,
    max: null,
    descriptionAr:
      'نوع مكافأة المُحيل: SUBSCRIPTION_CREDIT_DAYS (تمديد الاستحقاق) أو CHILD_REWARD_COINS (قيد في دفتر المكافآت).',
    humanDecision: true,
  },
  {
    key: 'referral.reward.referrerValue',
    type: 'INT',
    defaultValue: '30',
    min: 1,
    max: 365,
    descriptionAr: 'قيمة مكافأة المُحيل — أيام اشتراك إضافية أو عدد العملات، حسب `referral.reward.kind`.',
    humanDecision: true,
  },
  {
    key: 'referral.reward.referredValue',
    type: 'INT',
    defaultValue: '14',
    min: 0,
    max: 365,
    descriptionAr: 'ميزة الانضمام للطرف المُحال (أيام تجربة إضافية). صفر = لا ميزة.',
    humanDecision: true,
  },
  {
    key: 'referral.fraud.maxSentPerFamilyPerDay',
    type: 'INT',
    defaultValue: '20',
    min: 1,
    max: 500,
    descriptionAr: 'الحد الأقصى لدعوات الإحالة من أسرة واحدة في يوم واحد — حاجز ضد الإساءة السريعة.',
    humanDecision: false,
  },
  {
    key: 'referral.fraud.maxQualifiedPerFamilyPerMonth',
    type: 'INT',
    defaultValue: '10',
    min: 1,
    max: 1000,
    descriptionAr: 'الحد الأقصى للإحالات المؤهَّلة المدفوعة لأسرة واحدة شهريًا.',
    humanDecision: true,
  },
  // ---- activation ---------------------------------------------------------
  {
    key: 'activation.minMinutesAfterChildCreated',
    type: 'INT',
    defaultValue: '60',
    min: 0,
    max: 10_080,
    descriptionAr:
      'أقل مدة بين إنشاء الطفل وإتمام الهدف حتى يُعتبر «ذا معنى» — البوابة الثالثة في تعريف التفعيل.',
    humanDecision: true,
  },
  // ---- unit economics assumptions (FORECAST inputs, never ACTUAL) ----------
  {
    key: 'economics.grossMarginRate.EG',
    type: 'RATE',
    defaultValue: '0.596',
    min: 0.01,
    max: 1,
    descriptionAr: 'الهامش الإجمالي المفترض لمصر (docs/12 §10.2 = 59.6%). مُدخَل للتوقّع فقط، لا يُقدَّم كحقيقة.',
    humanDecision: false,
  },
  {
    key: 'economics.grossMarginRate.SA',
    type: 'RATE',
    defaultValue: '0.765',
    min: 0.01,
    max: 1,
    descriptionAr: 'الهامش الإجمالي المفترض للسعودية (docs/12 §10.2 = 76.5%).',
    humanDecision: false,
  },
  // ---- reporting ----------------------------------------------------------
  {
    key: 'reporting.timezone.EG',
    type: 'STRING',
    defaultValue: 'Africa/Cairo',
    min: null,
    max: null,
    descriptionAr: 'المنطقة الزمنية التي تُحسب عليها حدود اليوم في تقارير مصر.',
    humanDecision: false,
  },
  {
    key: 'reporting.timezone.SA',
    type: 'STRING',
    defaultValue: 'Asia/Riyadh',
    min: null,
    max: null,
    descriptionAr: 'المنطقة الزمنية التي تُحسب عليها حدود اليوم في تقارير السعودية.',
    humanDecision: false,
  },
  {
    key: 'reporting.timezone.PLATFORM',
    type: 'STRING',
    defaultValue: 'Africa/Cairo',
    min: null,
    max: null,
    descriptionAr: 'المنطقة الزمنية لليوم المرجعي على مستوى المنصة (الصفوف التي لا تخصّ بلدًا بعينه).',
    humanDecision: false,
  },
  // ---- alert thresholds ---------------------------------------------------
  {
    key: 'alerts.conversionDropPct',
    type: 'RATE',
    defaultValue: '0.20',
    min: 0.01,
    max: 1,
    descriptionAr: 'نسبة الانخفاض في التحويل مقارنةً بالأسبوع السابق التي تُطلق تنبيهًا.',
    humanDecision: false,
  },
  {
    key: 'alerts.churnRisePct',
    type: 'RATE',
    defaultValue: '0.25',
    min: 0.01,
    max: 5,
    descriptionAr: 'نسبة الارتفاع في التسرّب التي تُطلق تنبيهًا.',
    humanDecision: false,
  },
  {
    key: 'alerts.retentionDropPct',
    type: 'RATE',
    defaultValue: '0.15',
    min: 0.01,
    max: 1,
    descriptionAr: 'نسبة الانخفاض في احتفاظ D7 التي تُطلق تنبيهًا.',
    humanDecision: false,
  },
  {
    key: 'alerts.paymentFailureRate',
    type: 'RATE',
    defaultValue: '0.15',
    min: 0.01,
    max: 1,
    descriptionAr: 'نسبة فشل المدفوعات خلال 24 ساعة التي تُطلق تنبيهًا.',
    humanDecision: false,
  },
  {
    key: 'alerts.rewardFailureCount',
    type: 'INT',
    defaultValue: '10',
    min: 1,
    max: 100_000,
    descriptionAr: 'عدد رسائل الـ outbox الفاشلة على مسار المكافآت خلال 24 ساعة الذي يُطلق تنبيهًا.',
    humanDecision: false,
  },
  {
    key: 'alerts.notificationFailureCount',
    type: 'INT',
    defaultValue: '25',
    min: 1,
    max: 100_000,
    descriptionAr: 'عدد عمليات التسليم الفاشلة نهائيًا خلال 24 ساعة الذي يُطلق تنبيهًا.',
    humanDecision: false,
  },
  {
    key: 'alerts.countryShiftPct',
    type: 'RATE',
    defaultValue: '0.30',
    min: 0.01,
    max: 5,
    descriptionAr: 'نسبة التغيّر في تسجيلات بلد ما أسبوعًا بعد أسبوع التي تُعتبر «تحوّلًا جوهريًا».',
    humanDecision: false,
  },

  // ---- G16: the controlled pilot (Saudi Arabia + Egypt) -------------------
  //
  // WHY THESE LIVE HERE AND NOT IN `feature_flags`.
  // FeatureFlag was considered first and does not fit: its per-family targeting
  // is `enabled_family_ids`, and the pilot gate runs DURING REGISTRATION, when
  // no family row exists yet — there is nothing to target. Growth settings are
  // the right machinery for the opposite reason: they already provide schema
  // validation, bounds, an Arabic-described admin surface (`listAll`), a
  // documented default when no row exists, and change-without-a-deploy, which
  // is exactly what a pilot's country list and cohort id need.
  //
  // NOTHING IS LAUNCHED BY ADDING THESE. `pilot.enabled` defaults to `false`,
  // so on every existing and new deployment the gate is inert and registration
  // behaves precisely as it did before. Turning it on is an admin UPDATE.
  {
    key: 'pilot.enabled',
    type: 'BOOLEAN',
    defaultValue: 'false',
    min: null,
    max: null,
    descriptionAr:
      'المفتاح الرئيسي للتجربة المحدودة. القيمة الافتراضية false: البوابة معطّلة تمامًا ولا يتغيّر أي شيء في التسجيل. تشغيلها يعني أن الأسر في بلدان التجربة تحتاج دعوة.',
    humanDecision: true,
  },
  {
    key: 'pilot.countries',
    type: 'STRING',
    defaultValue: 'SA,EG',
    min: null,
    max: null,
    descriptionAr:
      'قائمة رموز ISO-3166 alpha-2 المفصولة بفواصل التي تسري عليها بوابة التجربة. البلد غير المذكور هنا لا يتأثر بالتجربة إطلاقًا.',
    humanDecision: true,
  },
  {
    key: 'pilot.cohortId',
    type: 'STRING',
    defaultValue: 'pilot-2026-q1',
    min: null,
    max: null,
    descriptionAr:
      'معرّف الفوج (cohort) الذي تُسجَّل فيه الأسر المدعوّة الآن. تغييره يبدأ فوجًا جديدًا دون أي تهجير للبيانات؛ الأفواج السابقة تبقى كما هي في سجلات الدعوات.',
    humanDecision: true,
  },
];

const SCHEMA_BY_KEY: ReadonlyMap<string, GrowthSettingSchema> = new Map(
  GROWTH_SETTING_SCHEMAS.map((s) => [s.key, s]),
);

export function growthSettingSchema(key: string): GrowthSettingSchema | undefined {
  return SCHEMA_BY_KEY.get(key);
}

export class UnknownGrowthSettingError extends Error {
  constructor(key: string) {
    super(`Unknown growth setting "${key}". Settings are a closed vocabulary; add it to GROWTH_SETTING_SCHEMAS.`);
  }
}

export class InvalidGrowthSettingError extends Error {
  constructor(key: string, detail: string) {
    super(`Invalid value for growth setting "${key}": ${detail}`);
  }
}

/**
 * Parses and validates a stored (or supplied) value against its schema.
 * Throws rather than coercing: a settings table with a value the code silently
 * reinterpreted is exactly as bad as a hardcoded constant, and harder to find.
 */
export function parseGrowthSetting(key: string, raw: string): number | string | boolean {
  const schema = SCHEMA_BY_KEY.get(key);
  if (!schema) throw new UnknownGrowthSettingError(key);

  switch (schema.type) {
    case 'STRING':
      if (raw.trim().length === 0) throw new InvalidGrowthSettingError(key, 'empty string');
      return raw.trim();
    case 'BOOLEAN':
      if (raw !== 'true' && raw !== 'false') {
        throw new InvalidGrowthSettingError(key, `expected "true" or "false", got "${raw}"`);
      }
      return raw === 'true';
    case 'INT': {
      const value = Number(raw);
      if (!Number.isInteger(value)) throw new InvalidGrowthSettingError(key, `expected an integer, got "${raw}"`);
      assertBounds(schema, value, key);
      return value;
    }
    case 'RATE': {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new InvalidGrowthSettingError(key, `expected a number, got "${raw}"`);
      assertBounds(schema, value, key);
      return value;
    }
    default: {
      // Exhaustiveness: a new value type must be handled, not defaulted.
      const exhaustive: never = schema.type;
      throw new InvalidGrowthSettingError(key, `unhandled type ${String(exhaustive)}`);
    }
  }
}

function assertBounds(schema: GrowthSettingSchema, value: number, key: string): void {
  if (schema.min !== null && value < schema.min) {
    throw new InvalidGrowthSettingError(key, `below minimum ${schema.min}`);
  }
  if (schema.max !== null && value > schema.max) {
    throw new InvalidGrowthSettingError(key, `above maximum ${schema.max}`);
  }
}

/** The default, already parsed. Used when no row exists for the key. */
export function defaultGrowthSetting(key: string): number | string | boolean {
  const schema = SCHEMA_BY_KEY.get(key);
  if (!schema) throw new UnknownGrowthSettingError(key);
  return parseGrowthSetting(key, schema.defaultValue);
}
