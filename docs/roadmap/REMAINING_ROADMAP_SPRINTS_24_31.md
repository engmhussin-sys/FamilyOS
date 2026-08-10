# Ebni — خارطة الطريق المتبقية (Sprint 24–31)

**مبنية على `COMPREHENSIVE_STATUS_REPORT.md`'s قسم 4 بالحرف — كل سبرنت هنا يقفل بند حقيقي موجود فيه، صفر بند مُخترَع.**

---

## Sprint 24 — فتح القفل البيئي (بنية تحتية، مش كود)

**نفس منطق Sprint 14 القديم، بس دلوقتي فيه كود حقيقي أكتر جاهز ينتظره.**

| المهمة | مين المسؤول | الناتج |
|---|---|---|
| رفع Railway: Postgres + Redis + Backend | الفريق (معنديش وصول Railway هنا) | Live URL |
| `prisma migrate deploy` + `prisma generate` | الفريق، بالأوامر الدقيقة في `SPRINT13_BLOCKED_BY_PRISMA.md` | Prisma Client حقيقي يعرف الـ 57 جدول |
| تشغيل الـ 94 اختبار Life Intelligence فعليًا لأول مرة | الفريق | أرقام PASS/FAIL حقيقية بدل "Test suite failed to run" |
| `flutter create` + أول Build حقيقي لـ Parent/Child App | الفريق (يحتاج Flutter SDK) | أول APK فعلي في تاريخ المشروع |

**معيار الإنجاز:** تسلسل التحقق في `SPRINT13_BLOCKED_BY_PRISMA.md` بيرجّع نتائج حقيقية مطابقة للمتوقَّع.

---

## Sprint 25 — ربط المحركات ببعضها + اكتمال Digital Twin

**الآلية موجودة، السلك مش موصول — أقرب شغلانة بالكود.**

- وصل `HabitEngineService`/`FaithEngineService`/`HealthEngineService` بـ `RewardsEngineService.processTriggerEvent` عند كل إنجاز حقيقي (مثال: إكمال عادة → تحقق من Reward Rules تلقائيًا)
- **Safety Score / Behavior Score في Digital Twin** — قراءة آمنة من `DeviceRiskAssessment`/`BehavioralIntelligenceEngineService` (نطاق Digital Safety) بدون كسر Code Freeze — أول خطوة: التحقق من الـ Interface الآمن للقراءة قبل أي كود
- اختبارات حقيقية لكل نقطة ربط جديدة

**معيار الإنجاز:** Growth Score بيوصل Confidence: HIGH (7 من 7 مؤشرات بدل 5).

---

## Sprint 26 — واجهات Dashboard المتبقية

**نفس نمط `DigitalTwinCard`/`LifeTimelineCard` المُتحقَّق منه فعليًا — بس لباقي المحركات.**

- `HabitTrackerCard` (سرد + إكمال عادات)
- `HealthTrendCard` (تسجيل تغذية/مياه/نوم/نشاط)
- `FaithProgressCard` (ممارسات + تسجيل)
- `FamilyStoreManagerCard` (إدارة المتجر + الموافقة على الاسترداد)
- `CoachingRecommendationsCard`

**معيار الإنجاز:** نفس معيار Sprint 19 بالحرف — `tsc` نظيف، `vite build` ناجح، صفر تراجع على الاختبارات الأصلية.

---

## Sprint 27 — واجهات Parent App المتبقية

- نفس الميزات الخمس من Sprint 26، بس Flutter
- شاشات Habit/Health/Faith تسجيل سريع (مناسبة للاستخدام اليومي المتكرر)
- شاشة إدارة المتجر العائلي

**معيار الإنجاز:** نفس معيار Sprint 20 — كود حقيقي، فحص توازن نظيف، **قابل للتحقق الفعلي هذه المرة** إذا Sprint 24 فتح قفل Flutter.

---

## Sprint 28 — تفعيل AI Provider (الذكاء الاصطناعي الفعلي)

**البنية جاهزة من قبل — دلوقتي التفعيل الحقيقي.**

- `FamilyCommunicationService.draftAiMessage` → ربط حقيقي بـ `IAIProvider` لصياغة الرسائل (مع `SafetyEngineService.validate()` قبل أي تسليم — نفس انضباط Digital Safety تمامًا)
- Smart Tasks Engine: السماح لـ LLM بإعادة صياغة `title`/`reason` فقط، **بدون المساس بمنطق القرار الحتمي** (نفس القاعدة المفروضة من البداية)
- Coaching Engine: نفس المبدأ — القرار حتمي، الصياغة بس بتتغيّر

**معيار الإنجاز:** كل رسالة AI-authored بتعدّي فعليًا على `SafetyEngineService` قبل أي `approve()`.

---

## Sprint 29 — واجهات Child App + أول Build حقيقي

- `plugins/family_growth/` — شاشة تسجيل عادات/صحة سريعة للطفل
- صندوق الرسائل (`ChildMessage` — القراءة فقط، بدون محادثة ثنائية، بنفس مبدأ عدم المراقبة)
- **أول APK حقيقي مبني وقابل للتثبيت**

**معيار الإنجاز:** APK فعلي، مثبَّت على محاكي على الأقل (حتى قبل جهاز حقيقي).

---

## Sprint 30 — تحقق أجهزة حقيقية

**يحتاج بنية تحتية معدومة هنا تمامًا — أجهزة Samsung/Xiaomi/Pixel فعلية.**

- تنفيذ `DEVICE_VALIDATION_MATRIX.md` بالكامل
- أي بگ حقيقي يُكتشف يُصلَح فورًا قبل الانتقال لـ Sprint 31 (نفس القاعدة المُتَّبعة طول المشروع)

---

## Sprint 31 — iOS + التصليب النهائي (Production Hardening الباقي)

**يحتاج Mac/Xcode — معدوم هنا تمامًا.**

- تنفيذ `IOS_IMPLEMENTATION_PLAN.md` (6 خطوات)
- إغلاق آخر الفجوات الصغيرة الباقية: أيقونة/شعار حقيقي، حماية لقطة الشاشة، تفعيل Push Notifications الحقيقي (FCM/APNs)
- مراجعة أمان نهائية شاملة قبل أي إطلاق تجريبي

---

## منطق الترتيب (ليه بالظبط بالترتيب ده)

**24 قبل أي حاجة** — بدونه، أي كود جديد هيتكرر معاه نفس مشكلة Sprint 13 بالضبط.
**25 قبل 26/27** — واجهة لمحرك ناقص الربط = بناء مرتين.
**26/27 قبل 28** — الذكاء الاصطناعي محتاج واجهة حقيقية يتفعّل فيها ويُختبَر بصريًا، مش مجرد استدعاء API.
**29 قبل 30** — نفس منطق المشروع الأصلي: نثبت المنصة قبل أي استثمار تاني.
**30 قبل 31** — إثبات Android على جهاز حقيقي قبل تكرار الاستثمار في iOS.

---

## جدول سريع — مين يقدر ينفّذ إيه هنا (في هذا الـ Sandbox تحديدًا)

| Sprint | قابل للتنفيذ هنا؟ |
|---|---|
| 24 | ❌ بنية تحتية بحتة — الفريق فقط |
| 25 | ✅ كود Backend بالكامل — قابل للتنفيذ والتحقق الجزئي (نفس قيد Prisma) |
| 26 | ✅ **قابل للتحقق الفعلي الكامل** (Dashboard = React) |
| 27 | 🟡 كود قابل للكتابة، غير قابل للتحقق (لا Flutter SDK) |
| 28 | ✅ كود Backend، نفس قيد Prisma |
| 29 | 🟡 نفس قيد Flutter |
| 30 | ❌ بنية تحتية بحتة |
| 31 | ❌ بنية تحتية بحتة (Mac/Xcode) |

**جاهز أبدأ Sprint 25 فورًا (أعلى قيمة قابلة للتنفيذ الحقيقي هنا دلوقتي)، أو أي سبرنت تاني تحددوه.**
