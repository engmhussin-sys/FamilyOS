# Google Play — Permissions Declaration & Data Safety (draft)

| Document ID | Version | Owner Role | Status | Last Updated |
|---|---|---|---|---|
| `ABNY-PLAY-DECL` | 0.1 (draft) | Senior Android/Flutter Engineer | **Draft — NOT submitted, NOT reviewed by counsel** | 2026-08-14 |

**التطبيق:** ابني | ABNY — Child Agent (`com.aifamilycoach.child_app`)
**المرجع:** `A3-Mobile-Audit.md` §4 (P1–P9) · `A0-Audit-Verdict.md` R5 · `CONTEXT.md` §3 مبدأ 7 و8.

> **تحذير صدق:** هذه الوثيقة **مسوّدة نصّية جاهزة للنسخ إلى Play Console**، وليست إعلانًا مقدَّمًا.
> لم يُقدَّم التطبيق إلى أي track حتى الآن، ولم يُبنَ APK واحد بنجاح في تاريخ المستودع (`A0/R1`).
> كل بند في §6 «ما ينقص» هو **حاجب حقيقي**، لا بند تحسيني.

---

## 1. لماذا نمرّ بالمراجعة اليدوية عمدًا

`accessibility_service_config.xml` يعلن `android:isAccessibilityTool="false"` **صراحةً**.

هذا **الجواب الصادق**: الخدمة ليست أداة إتاحة (accessibility aid) لمستخدم ذي إعاقة، بل آلية إنفاذ سياسة وقت شاشة ضبطها ولي الأمر. إعلان `true` كان سيمرّ آليًا اليوم و**يُسقط التطبيق لاحقًا** عند أول مراجعة بشرية، مع ما يتبعه من تعليق الحساب.

النتيجة المقصودة: التطبيق يسلك **مسار Permissions Declaration Form + فيديو demo + مراجعة بشرية**. المتوقع: **٢–٤ جولات**، كل جولة **٣–١٤ يومًا** (`A0/R5`).

---

## 2. نص الإعلان (Permissions Declaration Form) — مسوّدة

### 2.1 `AccessibilityService` — الاستخدام والغرض

> ABNY is a family digital-coaching app. A parent creates a screen-time plan for their child's device from the paired parent app. The child device needs to know **which application is in the foreground at this moment** in order to apply that plan at the moment it matters — when the child opens an app.
>
> The service is declared with:
> * `accessibilityEventTypes="typeWindowStateChanged"` — foreground app changes only, **not** `typeAllMask`;
> * `canRetrieveWindowContent="false"` — the app **cannot** read screen content, text fields, messages or passwords. This is enforced by the platform, not by policy;
> * `isAccessibilityTool="false"` — declared honestly;
> * no `packageNames` filter, because the service must be able to recognise **any** foreground app in order to know whether it is inside the plan.
>
> No alternative API achieves this. `UsageStatsManager` reports usage **after the fact**, in aggregate; it cannot trigger a break reminder at the moment an app opens. `DevicePolicyManager` requires device-owner provisioning, which is not available to a consumer app installed by a parent on an existing phone.
>
> Before the system Accessibility screen is ever opened, the app shows an in-app screen (`AccessibilityPrimingScreen`) in the user's language that states what the service reads, what it cannot read, why it is needed, and that it can be turned off at any time.

### 2.2 `SYSTEM_ALERT_WINDOW`

> Used for exactly one screen: a full-screen break reminder shown when the parent-set limit or bedtime is reached, with a single "back to home screen" button. It carries no advertising, collects no input, and is dismissible by the child at any time via that button.

### 2.3 `FOREGROUND_SERVICE_SPECIAL_USE`

> Subtype declared in the manifest via `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`. The service continuously evaluates the parent-configured screen-time plan on the child device. It maps to none of the predefined Android 14 types (not mediaPlayback, not location, not dataSync, not health) and cannot be periodic work, because enforcement must react at the moment the child opens an app.

### 2.4 `PACKAGE_USAGE_STATS`

> Produces the daily summary listed in §3 — per-app foreground minutes, already aggregated by Android itself. No per-tap or per-second logging is performed by this app.

### 2.5 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`

> Requested once, with an explanation, so the enforcement service is not killed overnight. Declining it does not disable the app; the plan simply becomes less reliable, and the app says so.

### 2.6 ما حُذف عمدًا

| الإذن | الحالة | السبب |
|---|---|---|
| `USE_EXACT_ALARM` | **محذوف (F1)** | مقصور على تطبيقات المنبّه/التقويم. تطبيق رقابة أبوية يعلنه يُرفض. البديل: `SCHEDULE_EXACT_ALARM` مع مسار تدهور آمن (`canScheduleExactAlarms()` ⇐ `setAndAllowWhileIdle`) |
| `WAKE_LOCK` | **محذوف (F1)** | صفر استخدام في الكود. كل إذن زائد = سطح مراجعة مجاني |
| `QUERY_ALL_PACKAGES` | **غير مطلوب إطلاقًا** | بدلًا منه `<queries>` بـ ١١ حزمة OEM مُسمّاة (F2) — انظر §5 |

---

## 3. الحقول التسعة التي تغادر الجهاز فعلًا

المصدر الوحيد للحقيقة: `apps/child-app/lib/plugins/screen_time/application/digital_wellbeing_service.dart` (حمولة `daily-summary`). **هذه القائمة مولَّدة من الكود، لا من وصف تسويقي له**، وهي نفسها المعروضة حرفيًا في شاشة الإفصاح داخل التطبيق.

| # | الحقل | ما هو | Data-safety category |
|---|---|---|---|
| 1 | `usageDate` | تاريخ الملخّص (YYYY-MM-DD) | App activity |
| 2 | `totalScreenMinutes` | إجمالي دقائق الشاشة | App activity |
| 3 | `appBreakdown[]` | لكل تطبيق: `packageName` + `minutes` + `category` | **App activity — other actions / app interactions** |
| 4 | `pickupCount` | عدد مرات إحضار تطبيق للمقدّمة | App activity |
| 5 | `nightUsageMinutes` | دقائق الاستخدام في `{22,23,0..5}` | App activity |
| 6 | `blockedAttemptCount` | عدد مرات فتح تطبيق خارج الخطة | App activity |
| 7 | `sessionCount` | عدد الجلسات | App activity |
| 8 | `averageSessionMinutes` | متوسط طول الجلسة | App activity |
| 9 | `longestSessionMinutes` | أطول جلسة | App activity |

**بالإضافة إلى ذلك** (خارج حمولة الملخّص اليومي، ويجب أن يظهر في نموذج Data Safety أيضًا):
`critical-event` (`eventType`, `title`, `body`, `metadata`) · تقرير الإمكانيات (`manufacturer`, `model`, `sdkInt`, حالة الأذونات الخمس, `profileHash`) · إشارات anti-tamper (سبع إشارات نصية) · مفتاح الجهاز العام (Keystore) للاقتران.

**ما لا يُجمَع إطلاقًا — ويُقال صراحةً في الشاشة وفي هذا الإعلان:**
محتوى الشاشة · ما يُكتَب (لا keylogging) · الرسائل · الصور · الميكروفون · الكاميرا · **الموقع الجغرافي** · جهات الاتصال · سجل التصفّح.

---

## 4. شاشات الإفصاح داخل التطبيق (مبنية في F2)

| الشاشة | الملف | متى تظهر | ما تثبته للمراجع |
|---|---|---|---|
| **Prominent Disclosure** | `features/onboarding/presentation/prominent_disclosure_screen.dart` | **أول تشغيل، قبل الاقتران وقبل أي إذن** | إفصاح داخل التطبيق (لا في سياسة الخصوصية وحدها)، يسمّي الحقول التسعة بالاسم، وبزرَّي قبول/رفض حقيقيين |
| **Accessibility Priming** | `features/onboarding/presentation/accessibility_priming_screen.dart` | **قبل شاشة النظام في كل مرة** | تمهيد ما قبل الإذن، يذكر ما يُقرأ وما لا يُقرأ وقابلية التراجع |
| **OEM Setup** | `features/onboarding/presentation/oem_setup_screen.dart` | مرة واحدة على الأجهزة المعنيّة + متاحة دائمًا | شفافية حول سبب طلب الاستثناء من البطارية |

**بوابة تقنية، لا وعد:** في `app.dart`، `HeartbeatService` و`DigitalWellbeingService` **لا يبدآن** قبل تسجيل الموافقة — حتى على تثبيت مقترن سابقًا يُحدَّث إلى هذا الإصدار.

---

## 5. `<queries>` بدل `QUERY_ALL_PACKAGES`

F2 أضاف ١١ حزمة OEM مُسمّاة في `<queries>` لفتح شاشات الـ autostart (Xiaomi, Oppo, Vivo, Huawei, Samsung, Transsion). **لم يُستخدم `QUERY_ALL_PACKAGES`** — وهو إذن مقيَّد كان سيضيف جولة مراجعة كاملة. النية هنا محدودة ومُعلَنة: فتح شاشة إعدادات، لا استعراض التطبيقات المثبَّتة.

---

## 6. ما ينقص قبل التقديم — قائمة حاجبة

| # | البند | الحالة | لماذا حاجب |
|---|---|---|---|
| 1 | **سياسة خصوصية منشورة على URL عام** | ❌ **غير موجودة** | إلزامية لكل تطبيق، ومضاعفة الإلزام لتطبيقات الأطفال. الكود جاهز لها: `--dart-define=PRIVACY_POLICY_URL=...` وإلا يُخفى الرابط بدل عرض رابط ميت |
| 2 | **فيديو demo** | ❌ غير مسجَّل | Play يطلبه لهذه الفئة. السيناريو في §7 |
| 3 | **نموذج Data Safety مُعبّأ** | ❌ | يجب أن يطابق §3 حرفيًا. أي تعارض بين النموذج وما ترسله الشبكة = إزالة |
| 4 | **Designed for Families / Target Audience** | ❌ | الجمهور ٦–١٧ سنة ⇒ إلزامي، ويستلزم مراجعة محتوى إضافية |
| 5 | **حساب Play Console + Internal Testing track** | ❌ | التوصية: افتح الـ track **في الأسبوع الذي يظهر فيه أول APK**، لا قبل الإطلاق بشهر |
| 6 | **ربط الموافقة المحلية بـ `ParentalConsent` في الـ backend** | ❌ | الجدول موجود (A2 §3.1) لكن شاشة F2 تكتب **محليًا فقط**. حاجب قانوني لا تقني |
| 7 | **`targetSdk` ≥ حدّ Play الحالي** | ⚠️ يتبع Flutter (34 على الأرجح) | `MA-012` — قد يمنع التقديم أصلًا |
| 8 | **رأي قانوني (مصر/السعودية) + GDPR-K/COPPA** | ❌ | `A0/R16`. مهلة ٤–٨ أسابيع ⇒ يبدأ الآن |
| 9 | **تشغيل فعلي على جهاز** | ❌ | كل ما في هذه الوثيقة `CODE VERIFIED`، صفر `TESTED` |

---

## 7. سيناريو فيديو الـ demo (٩٠–١٢٠ ثانية)

1. **٠:٠٠** تثبيت نظيف ⇒ **شاشة الإفصاح البارز** بالعربية. أظهر التمرير عبر الحقول التسعة كاملة، وزرَّي «فهمت — نكمل» و«ليس الآن».
2. **٠:٢٠** اضغط «ليس الآن» ⇒ أظهر أن **لا شيء يُرسَل** وأن العودة ممكنة. (هذا المشهد يجيب سؤال المراجع الأول: هل الرفض حقيقي؟)
3. **٠:٣٠** «فهمت» ⇒ شاشة الاقتران ⇒ إدخال كود من تطبيق الوالد.
4. **٠:٤٥** قائمة الأذونات ⇒ اضغط «إصلاح» بجوار «معرفة التطبيق المفتوح» ⇒ **شاشة التمهيد** تظهر **قبل** شاشة النظام. اقرأ سطر «ما الذي لا يُقرأ».
5. **١:٠٠** شاشة النظام ⇒ تفعيل ⇒ العودة ⇒ الحالة تتحول للأخضر تلقائيًا.
6. **١:١٠** من تطبيق الوالد: اضبط حدًّا يوميًا منخفضًا ⇒ على جهاز الطفل افتح تطبيقًا ⇒ **شاشة الاستراحة** بالعربية بنصّها غير العقابي («وقت الشاشة انتهى الآن. خذ استراحة صغيرة وارجع لهدفك.») + زر «نرجع للشاشة الرئيسية».
7. **١:٣٠** أظهر إيقاف الخدمة من الإعدادات ⇒ التطبيق **لا يمنع ذلك** ولا يعاقب، بل يعرض تنبيهًا بأن الحماية متوقفة.

> النقطة ٧ متعمّدة: أكثر ما يُسقط تطبيقات هذه الفئة هو أن تبدو **غير قابلة للإزالة أو للإيقاف**.

---

## 8. افتراضات ومخاطر مفتوحة

1. **افترضتُ أن نصّ §2 كافٍ لمراجع بشري.** لا سابقة لدينا؛ التقدير ٢–٤ جولات مأخوذ من `A0/R5` لا من تجربة هذا الحساب.
2. **قائمة الحقول التسعة صحيحة اعتبارًا من هذا الـ commit.** أي إضافة حقل إلى `buildAndQueueDailySummary` تجعل الشاشة **ونموذج Data Safety** كاذبَين. **المخفّف الوحيد اليوم مراجعة بشرية** — لا يوجد اختبار يربط الحمولة بنصّ الإفصاح. **بند إلزامي في F3.**
3. **الموافقة تُسجَّل محليًا فقط** (`SharedPreferences`, مفتاح `abny.consent.disclosureAcknowledgedV1`). إعادة تثبيت تمسحها ⇒ تُعرض الشاشة ثانية (الاتجاه الآمن)، لكنها **ليست سجلّ موافقة قانونيًا**.
4. **مفتاح الموافقة يحمل لاحقة `V1`.** أي تغيير جوهري في نص الإفصاح **يجب** أن يرفعها، وإلا لن يرى المستخدمون الحاليون النص الجديد.
5. **`isAccessibilityTool="false"` قرار لا رجعة فيه عمليًا.** تغييره إلى `true` لاحقًا بعد رفض هو بالضبط النمط الذي يُفسَّر كتحايل.
