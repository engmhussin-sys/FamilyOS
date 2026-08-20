# GROWTH & ANALYTICS API — عقد الواجهة للـ Admin Dashboard

| البند | القيمة |
|---|---|
| **Document ID** | `GROWTH-ANALYTICS-API` |
| **Version** | 1.0 |
| **Owner Role** | Growth Product Engineer (backend) |
| **Consumer** | `apps/admin-dashboard` |
| **Status** | مُنفَّذ ومُختبَر (31 اختبارًا e2e مقابل PostgreSQL حقيقي) |
| **Last Updated** | 2026-08-16 |
| **Base path** | `/admin/growth/*` (إداري) · `/referral/*` (والد) · `/analytics/*` (عام/والد) |

---

## 0. القواعد الخمس التي لا تتغيّر بين الإصدارات

اقرأ هذه أولًا؛ كل بقية الوثيقة تفصيل لها.

1. **كل قيمة رقمية تحمل `provenance`** من `ACTUAL | TARGET | FORECAST`. لا يوجد حقل رقمي في هذا العقد بلا هذه الصفة. الـ dashboard **ملزم** بعرض `FORECAST` بشكل مختلف بصريًا عن `ACTUAL` — تقديم افتراض كحقيقة هو نمط الفشل الوحيد الذي تُصمَّم هذه الطبقة كلها لمنعه.
2. **`null` يعني «لا توجد بيانات»، ولا يعني صفرًا أبدًا.** cohort عمره 45 يومًا يُرجع `RETENTION_D90: null`، ويجب أن يُعرض `—` لا `0%`. **هذا أهم سطر في العقد.**
3. **المال أعداد صحيحة بالوحدات الصغرى (`minor units`) ويحمل دائمًا `currencyCode`.** لا يوجد float، ولا يوجد افتراض بأن الوحدة الصغرى = 1/100 (العملة تحمل `minorUnits` كعمود). عند `countryCode=**` كل مؤشرات المال `null` — لأن جمع EGP مع SAR بلا سعر صرف كذب.
4. **الإضافة فقط.** مؤشر جديد يصل كعنصر جديد في مصفوفة `values`؛ dashboard قائم يتجاهله بلا ضرر. لا يُعاد استخدام اسم حقل بمعنى مختلف.
5. **لا endpoint إداري يقبل جلسة والد.** كل مسار تحت `/admin/growth/*` خلف `InternalAdminGuard` + `@PlatformAdminSurface()`. لا توجد نسخة «مقيَّدة بالأسرة» من أي منها ولن توجد: «كم أسرة تحوّلت في مصر» ليس سؤالًا يملك الـ tenant حق طرحه.

---

## 1. المصادقة (Authentication)

| السطح | الآلية | Header |
|---|---|---|
| `/admin/growth/*` | مفتاح إداري داخلي مشترك | `x-internal-admin-key: <INTERNAL_ADMIN_API_KEY>` |
| `/referral/*` | JWT والد (OWNER أو PARENT) | `Authorization: Bearer <accessToken>` |
| `POST /analytics/growth/install` | **عام** — لا يوجد ما يُصادَق عليه قبل وجود الحساب | — (throttle 10/min) |
| `POST /analytics/track` | JWT والد | `Authorization: Bearer <accessToken>` |

**رمز الحالة عند الرفض:** `401` بلا مفتاح، `403` بمفتاح/دور خاطئ. مُختبَر على الثمانية مسارات في `test/analytics/growth-api.e2e.spec.ts §1`.

---

## 2. الكتالوج — ابنِ عليه بدل أن تُكرّره

### `GET /admin/growth/catalogue`

تعريفات فقط، **بلا أي بيانات tenant**. آمن للتخزين المؤقت بقوة على العميل. وجوده يعني أن الـ dashboard **لا يحتاج** أن يُثبّت في كوده قائمة KPIs ولا قائمة قنوات ولا ترتيب funnel ولا اسم حدث.

```jsonc
{
  "kpis": [
    {
      "id": "ARPU",
      "nameEn": "Average Revenue Per User",
      "nameAr": "متوسط الإيراد لكل مستخدم",
      "kind": "MONEY_MINOR",              // COUNT | RATE | RATIO | MONEY_MINOR | DURATION_HOURS
      "formula": "net revenue (minor units) / active families, in ONE currency",
      "numerator": "SUM(payment_transactions.net_amount_minor) for SUCCEEDED rows in the currency",
      "denominator": "active families in the same period and country",
      "windowDays": 30,
      "source": "payment_transactions (Phase D, append-only)",
      "note": "NET of VAT. Gross ARPU includes money that was never ours ..."
    }
    // ... 22 مؤشرًا
  ],
  "growthEvents": [
    {
      "name": "REWARD_GRANTED",
      "tenancy": "FAMILY_SCOPED",          // FAMILY_SCOPED | ANONYMOUS
      "funnelStep": "FIRST_REWARD",        // أو null
      "producer": "GrowthDomainEventBridge (REWARD_GRANTED domain event)",
      "hadPriorDomainSignal": true,
      "priorSignal": "REWARD_GRANTED domain event (F3) — emitted only after a real ledger grant"
    }
    // ... 20 حدثًا
  ],
  "channels": ["ORGANIC","TIKTOK","INSTAGRAM","FACEBOOK","YOUTUBE","GOOGLE","INFLUENCER",
               "SCHOOL","PARENT_COMMUNITY","REFERRAL","PARTNERSHIP","APP_STORE","GOOGLE_PLAY","OTHER"],
  "funnelSteps": [
    { "step": "IMPRESSION", "source": "EXTERNAL_REPORTED", "measuredBy": "campaign_daily_spend.impressions", "note": "..." }
    // ... 11 خطوة بالترتيب
  ],
  "forecastScenarios": ["CONSERVATIVE","BASE","AGGRESSIVE"],
  "targetMetrics": ["USERS","PAID_USERS","REVENUE_MINOR","SUBSCRIPTIONS","CAC_MINOR","CHURN_RATE","MRR_MINOR"],
  "activation": {
    "eventName": "CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL",
    "ruleVersion": "MEANINGFUL_GOAL_V1",
    "meaningfulCompletionKinds": ["HABIT","TASK","HEALTH_GOAL","LEARNING_SESSION","FAITH_SESSION","ACHIEVEMENT"],
    "gates": ["REAL: ...", "A GOAL: ...", "NOT A DEMONSTRATION: ...", "FIRST: ..."]
  }
}
```

> **`funnelSteps[].source` مُلزِم بصريًا.** `EXTERNAL_REPORTED` يعني أن الرقم **بلاغ من منصة إعلانية**، لا قياس من عندنا. عرضه بنفس الوزن البصري لصف من `payment_transactions` كذب بالتنسيق.

---

## 3. المؤشرات (KPIs)

### `GET /admin/growth/kpis?countryCode=EG&asOf=2026-08-16T12:00:00Z`

| Param | مطلوب | القيمة |
|---|---|---|
| `countryCode` | لا (افتراضي `**`) | `EG` · `SA` · `**` (المنصة كلها) |
| `asOf` | لا (افتراضي الآن) | ISO-8601. حدود اليوم تُحسب على تقويم البلد |

```jsonc
{
  "countryCode": "EG",
  "currencyCode": "EGP",            // null عند countryCode=**
  "businessDate": "2026-08-16",     // اليوم على تقويم reporting.timezone.EG
  "reportingTimeZone": "Africa/Cairo",
  "values": [
    { "kpi": "DAU",             "provenance": "ACTUAL",   "value": 1200,  "currencyCode": null,  "kind": "COUNT" },
    { "kpi": "ARPPU",           "provenance": "ACTUAL",   "value": 15702, "currencyCode": "EGP", "kind": "MONEY_MINOR" },
    { "kpi": "RETENTION_D90",   "provenance": "ACTUAL",   "value": null,  "currencyCode": null,  "kind": "RATE" },
    { "kpi": "LTV",             "provenance": "FORECAST", "value": 280100,"currencyCode": "EGP", "kind": "MONEY_MINOR" }
  ]
}
```

**قائمة الـ `kpi` الكاملة (22):**
`DAU · WAU · MAU · STICKINESS · ACTIVATION_RATE · TIME_TO_VALUE_HOURS · RETENTION_D1 · RETENTION_D7 · RETENTION_D30 · RETENTION_D90 · CHURN_RATE · CONVERSION_RATE · TRIAL_CONVERSION_RATE · ARPU · ARPPU · MRR · ARR · CAC · LTV · LTV_CAC_RATIO · ROAS · PAYBACK_MONTHS`

**أيّها `FORECAST` دائمًا:** `LTV` · `LTV_CAC_RATIO` · `PAYBACK_MONTHS` — الثلاثة تضرب رقمًا مقيسًا في **هامش ربح مفترض**. لا تعرضها بلون `ACTUAL`.

### `GET /admin/growth/daily?countryCode=EG&from=...&to=...`

السلسلة اليومية المُخزَّنة (`growth_daily_metrics`) — هذا ما يقرأه الرسم البياني بدل إعادة مسح الجداول. صف واحد لكل (يوم، بلد)، يحمل `reportingTimeZone` الذي حُسب عليه.

```jsonc
[
  { "businessDate": "2026-08-15", "countryCode": "EG", "currencyCode": "EGP",
    "reportingTimeZone": "Africa/Cairo",
    "dau": 1200, "wau": 4000, "mau": 9000,
    "newRegistrations": 310, "activations": 96, "childrenAdded": 280, "devicesPaired": 190,
    "trialsStarted": 120, "trialsResolved": 88, "trialsConverted": 26,
    "newPaidFamilies": 26, "payingFamilies": 940, "activePaidSubscriptions": 940,
    "churnedPaidSubscriptions": 56,
    "paymentSuccessCount": 31, "paymentFailureCount": 4, "referralsQualified": 3,
    "netRevenueMinor": 486762, "mrrMinor": 14758800,
    "medianTimeToValueMinutes": 150 }
]
```

---

## 4. الـ Funnel والقنوات

### `GET /admin/growth/funnel?countryCode=EG&from=...&to=...&channel=TIKTOK&campaignId=<uuid>`

```jsonc
{
  "countryCode": "EG", "channel": "TIKTOK", "campaignId": null,
  "from": "2026-07-17T22:00:00.000Z", "to": "2026-08-16T22:00:00.000Z",
  "reportingTimeZone": "Africa/Cairo",
  "steps": [
    { "step": "IMPRESSION",  "count": 1200000, "source": "EXTERNAL_REPORTED",
      "stepConversion": null, "fromMeasurableTop": null, "note": "..." },
    { "step": "VISIT",       "count": 48000,  "source": "EXTERNAL_REPORTED", "stepConversion": 0.04,  "fromMeasurableTop": null, "note": "..." },
    { "step": "INSTALL",     "count": 9600,   "source": "ANALYTICS_EVENT",   "stepConversion": 0.2,   "fromMeasurableTop": 1,     "note": "..." },
    { "step": "REGISTRATION","count": 3100,   "source": "DOMAIN_TABLE",      "stepConversion": 0.3229,"fromMeasurableTop": 0.3229,"note": "..." }
    // FAMILY_CREATED · CHILD_ADDED · FIRST_GOAL · FIRST_REWARD · TRIAL · PAID · RENEWAL
  ],
  "monotonicityViolations": []
}
```

- **`count` عدد أُسَر لا أحداث.** أسرة بثلاثة أطفال عبرت `CHILD_ADDED` مرة واحدة.
- **`monotonicityViolations`** مصفوفة نصوص تشخيصية عندما يتجاوز عدد خطوة عدد سابقتها. تُبلَّغ ولا تُخفى: السبب الحقيقي عادةً بلاغ ناقص من منصة إعلانية، وتصفير الفرق يجعل البيانات تبدو نظيفة وهي خاطئة.
- **`fromMeasurableTop`** التحويل من `INSTALL` — أول خطوة يقيسها هذا الـ backend فعلًا.

### `GET /admin/growth/channels?countryCode=EG&from=...&to=...`

```jsonc
[ { "channel": "TIKTOK", "registrations": 3100, "paid": 310, "conversion": 0.1 } ]
```
القنوات ذات الصفر في الطرفين محذوفة من الرد.

---

## 5. الحملات (Campaigns)

### `GET /admin/growth/campaigns?countryCode=EG` · `GET /admin/growth/campaigns/:id`

```jsonc
{
  "id": "…", "name": "ramadan-2026", "channel": "TIKTOK",
  "countryCode": "EG", "currencyCode": "EGP",
  "startsAt": "2026-03-01T00:00:00.000Z", "endsAt": "2026-04-01T00:00:00.000Z",
  "isActive": true,

  // ── يحدّدها الـ admin. لا قيمة افتراضية في أي مكان في هذا الـ module ──
  "budgetMinor": 5000000, "targetUsers": 10000, "targetPaidUsers": 1000,

  // ── تُبلّغها المنصة الإعلانية (استيراد يومي idempotent) ──
  "spendMinor": 4820000, "impressions": 1200000, "clicks": 62000, "visits": 48000, "leads": 0,
  "budgetUtilisation": 0.964,

  // ── نقيسها نحن من صفوف كتبها الخادم ──
  "installs": 9600, "registrations": 3100, "paidUsers": 310, "netRevenueMinor": 4867620,

  "kpis": [
    { "kpi": "CAC",             "provenance": "ACTUAL", "value": 15548, "currencyCode": "EGP", "kind": "MONEY_MINOR" },
    { "kpi": "ROAS",            "provenance": "ACTUAL", "value": 1.01,  "currencyCode": null,  "kind": "RATIO" },
    { "kpi": "CONVERSION_RATE", "provenance": "ACTUAL", "value": 0.1,   "currencyCode": null,  "kind": "RATE" }
  ],
  "targetAttainment": { "users": 0.31, "paidUsers": 0.31 }
}
```

### `POST /admin/growth/campaigns`

```jsonc
{ "name": "ramadan-2026", "channel": "TIKTOK", "countryCode": "EG",
  "budgetMinor": 5000000, "currencyCode": "EGP",
  "startsAt": "2026-03-01T00:00:00Z", "endsAt": "2026-04-01T00:00:00Z",
  "targetUsers": 10000, "targetPaidUsers": 1000,
  "utmCampaign": "ramadan-2026", "notes": "…" }
```
`budgetMinor` · `targetUsers` · `targetPaidUsers` **إلزامية** (أعمدة NOT NULL) — حملة بلا ميزانية أو هدف مُعلَن **لا يمكن أن توجد**. الرد `{ "id": "<uuid>" }` بحالة `201`.

### `POST /admin/growth/campaigns/:id/spend`

```jsonc
{ "businessDate": "2026-08-15", "spendMinor": 120000,
  "impressions": 100000, "clicks": 5200, "visits": 4100, "leads": 0 }
```
**idempotent على `(campaign, businessDate)`**: إعادة استيراد اليوم نفسه **تُصحِّح** الصف ولا تُضاعف الإنفاق — ومضاعفة الإنفاق كانت ستُنصِّف الـ CAC المُبلَّغ في الاتجاه المُطمئِن.

---

## 6. التوقّع والأهداف — ثلاثة حقول لا يُدمج أيّها

### `GET /admin/growth/quarterly?countryCode=EG&year=2026`

**28 صفًا** (4 أرباع × 7 مؤشرات). كل صف يحمل الثلاثة دائمًا:

```jsonc
[
  { "countryCode": "EG", "year": 2026, "quarter": 3, "metric": "PAID_USERS",
    "target":   1000,     // كتبه إنسان. null = لم يلتزم أحد بشيء — ولا يُستنتَج من التوقّع أبدًا
    "actual":   310,      // مقيس. null قبل بدء الربع، لا صفر
    "forecast": 1160,     // من `growth_forecast_scenarios`
    "attainment": 0.31,   // actual/target، موجود فقط عندما يوجد الاثنان
    "currencyCode": null }
]
```

> **لا يوجد حقل `value` في هذا الرد ولن يوجد.** الـ dashboard الذي يريد رقمًا واحدًا مُلزَم بأن يقرر أيّها يعرض — وهذا بالضبط القرار الذي يجب ألّا يُتَّخذ صامتًا.

### `POST /admin/growth/quarterly/target`
```jsonc
{ "countryCode": "EG", "year": 2026, "quarter": 3, "metric": "PAID_USERS",
  "targetValue": 1000, "currencyCode": null, "note": "board commit" }
```

### `GET /admin/growth/forecast?countryCode=EG&months=12`

```jsonc
[
  { "scenario": "BASE", "countryCode": "EG", "currencyCode": "EGP",
    "assumptions": { "monthlyAcquisition": 10000, "conversionRate": 0.25,
                     "paidConversionRate": 0.4, "churnRate": 0.06,
                     "arpuMinor": 17900, "cacMinor": 35000, "retentionD30": 0.35 },
    "months": [
      { "monthIndex": 1, "newRegistrations": 10000, "newTrials": 2500, "newPaid": 1000,
        "churnedPaid": 0, "endingPaid": 1000, "mrrMinor": 17900000, "acquisitionSpendMinor": 35000000 }
    ],
    "endingPaid": 8420, "endingMrrMinor": 150718000, "totalSpendMinor": 350000000 }
]
```

**الافتراضات تُعاد مع كل توقّع مُشتقّ منها** — كي يستطيع القارئ أن يختلف مع المُدخلات بدل أن يختلف مع المُخرَج. النموذج **roll-forward شهري بتسرّب ثابت**، وبساطته مُعلَنة لا مخفيّة: ليس نموذج بقاء، ولا يُلائم منحنى احتفاظ مرصود، وسيميل للتفاؤل في الربع الأول بعد الإطلاق.

### `POST /admin/growth/forecast/scenario`
نفس شكل `assumptions` أعلاه + `scenario` و `countryCode` و `currencyCode`. أي معدل خارج `[0,1]` يُرفض بـ `400` **قبل** أن يُنتج توقّعًا مستحيلًا (وقيد CHECK في قاعدة البيانات يرفضه ثانيةً).

---

## 7. التنبيهات

### `GET /admin/growth/alerts?acknowledged=false&limit=50`

```jsonc
[
  { "id": "…", "alertType": "CONVERSION_DROP", "scopeKey": "EG",
    "businessDate": "2026-08-16", "severity": "CRITICAL",
    "message": "انخفض معدل التحويل في EG من 10.20% إلى 7.10% خلال أسبوع.",
    "observedValue": 0.3039, "thresholdValue": 0.2,
    "acknowledgedAt": null, "createdAt": "2026-08-16T03:00:12.100Z" }
]
```

**الأنواع الثمانية:** `CONVERSION_DROP · CHURN_RISE · PAYMENT_FAILURE_SPIKE · REWARD_FAILURE_RISE · NOTIFICATION_FAILURE_RISE · AI_SAFETY_INCIDENT · RETENTION_DROP · COUNTRY_PERFORMANCE_SHIFT`.

- **تنبيه واحد لكل (نوع، نطاق، يوم)** — مفروض بـ UNIQUE index، لا بـ cooldown في الذاكرة (الذي يُصفَّر عند أي deploy، والـ deploy أثناء الحادثة هو بالضبط لحظة وصول العاصفة).
- **`AI_SAFETY_INCIDENT` وحده يسمّي أسرة** (`family_id`)، والجدول `PLATFORM_ANNOTATED` تحديدًا كي يراه المشغّل ولا يراه أي tenant.

### `POST /admin/growth/alerts/:id/acknowledge` → `{ "ok": true }`

---

## 8. الإعدادات — كل رقم تجاري قابل للتعديل بلا deploy

### `GET /admin/growth/settings`

```jsonc
[
  { "key": "referral.qualification.refundWindowDays", "value": 14,
    "isDefault": true, "type": "INT", "min": 0, "max": 180,
    "descriptionAr": "عدد الأيام التي يجب أن تمرّ على دفعة ناجحة قبل اعتبار الإحالة «مؤهَّلة» …",
    "humanDecision": true }
]
```

> **`humanDecision: true` يجب أن يُعرض مختلفًا.** هذه هي الأرقام التي ما زال يلزمها مالك من جانب العمل — قيمة مكافأة الإحالة، نافذة الاسترداد، عتبة التفعيل، سقف الإحالات الشهري.

### `POST /admin/growth/settings` → `{ "key": "...", "value": "..." }`
القيمة تُتحقَّق مقابل schema المفتاح (النوع + الحدود) **قبل** أن تصل الجدول؛ مفتاح غير معروف أو قيمة خارج الحدود تُرفض ولا تُخزَّن.

---

## 9. سطح الوالد — الإحالة

| Endpoint | Method | Auth | الرد |
|---|---|---|---|
| `/referral/me` | GET | JWT والد | `{ code, isActive, sentCount, registeredCount, qualifiedCount }` |
| `/referral/link` | POST | JWT والد | `{ url, channel }` — idempotent لكل (code، channel) |
| `/referral/sent` | POST | JWT والد | `{ ok: true }` · `409` عند تجاوز حدّ اليوم |

**ما هو غائب عمدًا من كل هذه الردود:** أي معرّف أسرة أخرى. المُحيل يعرف **كم** من دعواته تحوّلت، ولا يعرف **من** — قرار منتج بقدر ما هو قرار خصوصية.

**لا يوجد endpoint يستطيع عميل عبره أن يعلن تحويلًا.** الربط يحدث داخل التسجيل من كود حمله الحساب الجديد، والتأهيل يحدث على وظيفة مجدولة من دفعة مُتحقَّق منها خادميًا. عميل يستطيع قول «هذه الأسرة تحوّلت، ادفع لي» هو واجهة لطباعة المكافآت.

---

## 10. سطح العميل — الحدث الوحيد المسموح

### `POST /analytics/growth/install` (عام · throttle 10/min · `202`)

```jsonc
{ "sessionId": "sess-abc", "platform": "ANDROID", "countryCode": "EG",
  "appVersion": "1.4.0", "locale": "ar", "source": "tiktok",
  "campaign": "ramadan-2026", "medium": "cpc", "referralCode": "ABCD2345" }
```

`sessionId` هو **الوصلة الوحيدة** بين ما قبل التسجيل وما بعده — يُعاد إرساله داخل `attribution` عند `POST /auth/register`، وبدونه لا يمكن نسب INSTALL لحملة إطلاقًا.

### `POST /auth/register` — التقاط النسب

```jsonc
{ "email": "...", "password": "...", "fullName": "...", "acceptedTerms": true,
  "attribution": {
    "source": "tiktok", "campaign": "ramadan-2026", "medium": "cpc", "content": "video-a",
    "countryCode": "EG", "platform": "ANDROID", "referralCode": "ABCD2345",
    "referrer": "https://ads.tiktok.com/x", "landingPage": "https://abny.app/ar/parents",
    "sessionId": "sess-abc" } }
```

كل الحقول اختيارية. كود إحالة خاطئ **لا يُفشل التسجيل** — تُنشأ الأسرة بلا نسب لأحد. كود الإحالة **يفوز بالقناة** على أي UTM آخر.

---

## 11. جدول العقد المختصر

| Endpoint | Method | Auth | يُرجع |
|---|---|---|---|
| `/admin/growth/catalogue` | GET | admin key | تعريفات KPIs/أحداث/قنوات/funnel/تفعيل |
| `/admin/growth/kpis` | GET | admin key | `IKpiSnapshot` — 22 قيمة بـ provenance |
| `/admin/growth/funnel` | GET | admin key | 11 خطوة + انتهاكات الرتابة |
| `/admin/growth/channels` | GET | admin key | تسجيلات/مدفوع/تحويل لكل قناة |
| `/admin/growth/daily` | GET | admin key | السلسلة اليومية المخزَّنة |
| `/admin/growth/campaigns` | GET | admin key | أداء كل حملة |
| `/admin/growth/campaigns/:id` | GET | admin key | أداء حملة واحدة |
| `/admin/growth/campaigns` | POST | admin key | `{ id }` |
| `/admin/growth/campaigns/:id/spend` | POST | admin key | `{ ok }` (idempotent يوميًا) |
| `/admin/growth/forecast` | GET | admin key | سيناريوهات + افتراضاتها |
| `/admin/growth/forecast/scenario` | POST | admin key | `{ ok }` |
| `/admin/growth/quarterly` | GET | admin key | 28 صفًا target/actual/forecast |
| `/admin/growth/quarterly/target` | POST | admin key | `{ ok }` |
| `/admin/growth/alerts` | GET | admin key | تنبيهات المشغّل |
| `/admin/growth/alerts/:id/acknowledge` | POST | admin key | `{ ok }` |
| `/admin/growth/settings` | GET | admin key | كل رقم تجاري + schema + `humanDecision` |
| `/admin/growth/settings` | POST | admin key | `{ ok }` |
| `/referral/me` | GET | JWT والد | كود الأسرة + عدّاداتها |
| `/referral/link` | POST | JWT والد | `{ url, channel }` |
| `/referral/sent` | POST | JWT والد | `{ ok }` |
| `/analytics/growth/install` | POST | عام | `202` |
| `/analytics/track` | POST | JWT والد | `201` |
| `/analytics/dashboard-metrics` | GET | admin key | مقاييس Sprint 8 (ما زالت قائمة) |

---

## افتراضات ومخاطر مفتوحة

1. **`countryCode=**` لا يُرجع مالًا.** إن احتاج الـ dashboard رقمًا موحّدًا عبر السوقين فهو **يحتاج سعر صرف** — وهو قرار مالي (سعر أي يوم؟ متوسط؟ مثبَّت؟) لم يُتَّخذ، ولن يُخترع داخل طبقة تحليلات.
2. **`IMPRESSION` و `VISIT` بلاغات خارجية.** دقّتهما دقّة تصدير المنصة الإعلانية وانضباط من يستورده. إن لم يُستورد شيء ظهرا صفرًا، وسيُبلَّغ ذلك في `monotonicityViolations` عندما تتجاوزهما خطوة لاحقة.
3. **`RENEWAL` = الدفعة الناجحة الثانية.** أسرة على خطة سنوية لن تُسجَّل كتجديد قبل مرور سنة؛ هذا صحيح ومقصود، لكنه يجعل الخطوة شبه فارغة في السنة الأولى.
4. **عتبات التنبيهات وقيَم مكافأة الإحالة افتراضات أولية**، كلها في `/admin/growth/settings` بـ `humanDecision: true`. التنبيه بالعتبة الخاطئة أسوأ من عدم التنبيه.
5. **`LTV` يعتمد هامشًا مفترضًا** (مصر 59.6% · السعودية 76.5%، من `docs/12-Cost-Estimate.md §10.2`). لهذا هو `FORECAST` ولن يصبح `ACTUAL` قبل وجود محاسبة تكلفة حقيقية لكل أسرة.
