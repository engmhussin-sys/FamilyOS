# جاهزية المتاجر — تدقيق تقني لما **يوجد في الريبو** مقابل ما **يطلبه المتجر**

| Document ID | Version | Owner Role | Status | Last Updated |
|---|---|---|---|---|
| REL-STORE-READY-001 | 1.0 | Mobile Release Lead | `STATIC VERIFIED` — **لا artifact، ولا تقديم، ولا ادّعاء جاهزية** | 2026-08-17 |

> ## ما هذه الوثيقة، وما ليست
>
> **ليست إعلان جاهزية.** لا يوجد APK واحد في تاريخ هذا المشروع، ولم يُشغَّل
> `flutter build` قط. لا يمكن أن يكون شيء «جاهزًا للمتجر» قبل وجود artifact.
>
> **وليست نصًّا قانونيًا.** لا سياسة خصوصية ولا شروط استخدام ولا نصّ موافقة
> مكتوب هنا، ولا واحدة منها **مُختلَقة**. حيث يلزم نصّ قانوني، الصفّ مكتوب
> `HUMAN DECISION` ويقف عند ذلك.
>
> **هي:** جرد تقني، صفًّا صفًّا، لما تحويه الشجرة فعلًا مقابل ما يطلبه كل
> متجر، بثلاث حالات فقط: **`PRESENT`** (‏موجود في الريبو، ويُشار إلى الملف) ·
> **`MISSING`** (‏غير موجود، وهو حاجز) · **`HUMAN DECISION`** (‏لا يمكن لأي
> كمية كود أن تحسمه — قرار تجاري أو قانوني أو تصميمي).
>
> الوثيقة الشقيقة `docs/release/PLAY_POLICY_DECLARATION.md` تغطّي **نصّ إعلان
> الأذونات وسيناريو فيديو الـ demo**؛ هذه الوثيقة تغطّي **الأصول والحقول
> والإعدادات**. لا تكرار مقصود بينهما.

---

## 0. الحقيقة الأولى: **App Store غير مطروح أصلًا**

```
$ ls apps/parent-app     ->  android  lib  pubspec.yaml  test  (+ وثيقتان)
$ ls apps/child-app      ->  android  lib  pubspec.yaml  test
```

**لا يوجد مجلد `ios/` في أيٍّ من التطبيقين.** لا `Runner.xcodeproj`، ولا
`Info.plist`، ولا bundle identifier، ولا أي `NS*UsageDescription`. أي أن كل
صفوف App Store أدناه ليست «ناقصة» بل **غير مبدوءة**: توليد `ios/` هو أمر
`flutter create --platforms=ios .` واحد، لكن ما بعده (توقيع، Xcode، جهاز Mac،
وإعادة تنفيذ طبقة الإنفاذ الأصلية التي **لا يوجد لها مقابل على iOS**) مشروع
مستقل لا بند في قائمة.

**النتيجة العملية:** المسار الوحيد القابل للتقديم اليوم هو **Google Play،
تطبيقان منفصلان**. وكل ما تحته مكتوب على هذا الأساس.

---

## 1. الهوية والحزم

| # | البند | الحالة | الدليل / الملف | ملاحظة |
|---|---|---|---|---|
| 1.1 | `applicationId` (والد) | **HUMAN DECISION** | `apps/parent-app/android/app/build.gradle` ⇒ `com.aifamilycoach.parent_app` | ⚠️ **قرار حيّ.** العلامة «ابني» / **ABNY**، والحزمة تقول `aifamilycoach`. و`applicationId` **لا يتغيّر بعد أول نشر على Play** — تغييره لاحقًا يعني تطبيقًا جديدًا وفقدان كل مستخدم وكل تقييم. **يُحسم قبل أول رفع، لا بعده.** |
| 1.2 | `applicationId` (طفل) | **HUMAN DECISION** | `apps/child-app/android/app/build.gradle` ⇒ `com.aifamilycoach.child_app` | نفس القرار حرفيًا، ويحكم أيضًا `google-services.json` (‏`FIREBASE_SETUP.md`) |
| 1.3 | `namespace` يطابق `applicationId` | `PRESENT` | كلا الملفين | مطابق، ويطابق `package` في `MainActivity.kt` |
| 1.4 | اسم التطبيق المعروض (عربي) | `PRESENT` | `res/values-ar/strings.xml` ⇒ **«ابني — نكبر معًا»** | التطبيقان يحملان **الاسم نفسه** — على جهاز واحد لا يظهران معًا عادةً، لكن في Play Console عنوانان متطابقان لتطبيقين مشكلة قائمة |
| 1.5 | اسم التطبيق المعروض (إنجليزي) | `PRESENT` | `res/values/strings.xml` ⇒ `ABNY — Grow Together` | **‏`grep -rni ebney apps/child-app apps/parent-app` ⇒ صفر مطابقة.** الشجرة القابلة للشحن تقول **ABNY** فقط، في `app_name` و`accessibility_service_label` و`accessibility_service_description`. الصيغة `EBNEY` ترد في وثائق القرار (`PROJECT_STATUS.md §0`, `FIREBASE_SETUP.md`) **كقرار تسمية مفتوح لم يُطبَّق على أي كود** — وهو نفس القرار المذكور في 1.1 |
| 1.6 | `versionCode` / `versionName` | ⚠️ `PRESENT` بقيمة افتراضية | `build.gradle` يقرأ `local.properties`، وإلا `1` / `1.0` | `pubspec.yaml` يقول `version: 0.1.0` بلا `+build`. Play يرفض إعادة رفع نفس الـ `versionCode` — **يلزم مصدر واحد قبل أول رفع** |

---

## 2. الأصول المرئية

| # | البند | الحالة | الدليل | ملاحظة |
|---|---|---|---|---|
| 2.1 | أيقونة المُشغِّل — 5 كثافات | `PRESENT` | `mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher.png` في التطبيقين | القياسات صحيحة: 48/72/96/144/192 |
| 2.2 | الأيقونتان مختلفتان بين التطبيقين | `PRESENT` | md5 مختلف في الكثافات الخمس | أي **ليستا قالب Flutter الافتراضي نفسه** |
| 2.3 | Adaptive icon (‏API 26+) | **MISSING** | لا `mipmap-anydpi-v26/ic_launcher.xml` ولا `ic_launcher_foreground` | `minSdk 21`/`targetSdk 34`: على كل جهاز API 26+ سيقصّ المُشغِّل الصورة النقطية في قناع دائري. **ليس حاجز تقديم، لكنه أول ما يُلاحَظ بصريًا** |
| 2.4 | أيقونة 512×512 لصفحة Play | **MISSING** | لا وجود لها في الريبو | **حاجز رفع** — Play Console لا يقبل نشرة بلا أيقونة عالية الدقة |
| 2.5 | Feature graphic 1024×500 | **MISSING** | — | **حاجز رفع** |
| 2.6 | لقطات شاشة (هاتف، ٢–٨) | **MISSING** | — | **حاجز رفع**، ولا يمكن التقاطها قبل وجود APK يعمل |
| 2.7 | شاشة البدء (splash) | ⚠️ `PRESENT` لكنها القالب | `drawable/launch_background.xml` ⇒ `@android:color/white` فقط، و`drawable-v21` و`values-night` موجودة | تعليق الملف يقول ذلك صراحة: «standard Flutter template». **أبيض سادة، بلا شعار.** `HUMAN DECISION` تصميمي، لا حاجز |
| 2.8 | `supportsRtl="true"` | `PRESENT` | كلا الـ Manifest | لازم للعربية، وموجود |
| 2.9 | `localeConfig` (‏per-app language) | `PRESENT` | `res/xml/locales_config.xml` في التطبيقين | |

---

## 3. الأذونات — القائمة الكاملة، وتبرير كل واحد بلغة بشرية

### 3.1 تطبيق الطفل — `apps/child-app/android/app/src/main/AndroidManifest.xml`

| الإذن | لماذا هو موجود، بجملة يفهمها المراجع | مستعمَل فعلًا في الكود؟ |
|---|---|---|
| `INTERNET` | كل نداء للـ backend | نعم |
| `PACKAGE_USAGE_STATS` ⚠️ | لمعرفة كم دقيقة قضاها الطفل في كل تطبيق اليوم — وهو **جوهر** خطة وقت الشاشة. إذن خاص، يُمنح من شاشة نظام | نعم — `UsageStatsCollector` |
| `BIND_ACCESSIBILITY_SERVICE` (‏عبر الخدمة) ⚠️ | لمعرفة **اسم** التطبيق المفتوح الآن فقط، لتطبيق الخطة لحظة فتحه. `accessibility_service_config.xml` يعلن `canRetrieveWindowContent=false` — **فالنظام نفسه لا يمنح محتوى الشاشة** | نعم — `ChildGuardAccessibilityService` |
| `SYSTEM_ALERT_WINDOW` ⚠️ | لعرض شاشة «وقت استراحة» فوق التطبيق عند بلوغ الحد. هي **نقطة الاحتكاك الوحيدة** في المنتج | نعم — `OverlayManager` |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` ⚠️ | لإبقاء تقييم الخطة يعمل بينما الجهاز مستعمَل | نعم — `ChildGuardForegroundService` |
| `RECEIVE_BOOT_COMPLETED` | لاستئناف الحماية بعد إعادة التشغيل — بدونها يُلغى الإنفاذ بإعادة تشغيل | نعم — `BootReceiver` |
| `POST_NOTIFICATIONS` | لإشعار الخدمة الدائم وتنبيه «الحماية متوقفة» | **مُعلَن ويُقرأ، ولا يُطلَب** — انظر §5.3 |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | لطلب استثناء البطارية، وهو الشيء الوحيد الذي يُبقي الوكيل حيًّا ليلًا | نعم — `PermissionManager` |
| `SCHEDULE_EXACT_ALARM` | لتنبيه وقت النوم في وقته. **يتدهور بأمان**: `canScheduleExactAlarms()` ⇒ منبّه غير دقيق | نعم — `RuntimeWatchdogScheduler` |
| `<queries>` بـ ١١ حزمة OEM | لفتح شاشة «التشغيل التلقائي» في مركز أمان الشركة المصنّعة. **البديل `QUERY_ALL_PACKAGES` مرفوض عمدًا** | نعم — `OemBackgroundRestrictionManager` |

**ثلاثة أذونات حُذفت عمدًا وهذا في صالح المراجعة:** `USE_EXACT_ALARM` (‏مقصور
على تطبيقات المنبّه/التقويم — إعلانه رفض شبه مؤكّد) · `WAKE_LOCK` (‏صفر
استخدام) · `QUERY_ALL_PACKAGES` (‏استُبدل بـ `<queries>` مُسمّاة).

### 3.2 تطبيق الوالد

| الإذن | لماذا | مستعمَل؟ |
|---|---|---|
| `INTERNET` | كل نداء للـ backend | نعم |
| `POST_NOTIFICATIONS` | إشعارات Firebase Messaging | نعم — `PushRegistrationService` يستدعي `messaging.requestPermission()` |

**لا إذن ثالث.** وهذا صحيح ومقصود: تطبيق الوالد لوحة عرض، لا يراقب جهازه هو.

### 3.3 صفوف الحالة

| # | البند | الحالة | ملاحظة |
|---|---|---|---|
| 3.a | كل إذن حسّاس له استعمال حقيقي في الكود | `PRESENT` | فُحص بـ grep لكل بند أعلاه |
| 3.b | `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` | `PRESENT` | إلزامي على API 34+، ومكتوب بنصّ يشرح **لماذا لا يصلح عمل دوري** — وهو سؤال المراجع الحرفي |
| 3.c | وصف خدمة الوصول بالعربية والإنجليزية | `PRESENT` | `accessibility_service_description` في اللغتين، ويذكر **ما لا يُقرأ** بالاسم |
| 3.d | `isAccessibilityTool` | `HUMAN DECISION` | الجواب الصادق (`false`) **يفتح المراجعة اليدوية عمدًا**. لا يُغيَّر لتفادي المراجعة |
| 3.e | نموذج إعلان الأذونات مُقدَّم | **MISSING** | المسوّدة في `PLAY_POLICY_DECLARATION.md §2`، غير مُقدَّمة |
| 3.f | فيديو demo | **MISSING** | السيناريو موجود (§7 هناك)، لم يُصوَّر — ويستحيل تصويره بلا APK |

---

## 4. التنفيذ في الخلفية

| # | البند | الحالة | الدليل |
|---|---|---|---|
| 4.1 | `foregroundServiceType="specialUse"` | `PRESENT` | Manifest الطفل |
| 4.2 | تبرير الـ subtype مكتوبًا | `PRESENT` | `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" …>` |
| 4.3 | مستقبِل `BOOT_COMPLETED` | `PRESENT` | `.core.BootReceiver` |
| 4.4 | WorkManager watchdog | `PRESENT` | `RuntimeWatchdogWorker.kt` + `androidx.work:work-runtime-ktx:2.9.0` |
| 4.5 | مسار OEM (‏autostart) | `PRESENT` | `oem_setup_screen.dart` + `<queries>` |
| 4.6 | إشعار الخدمة الأمامية مُترجَم | `PRESENT` | `notif_protection_*` في اللغتين |
| 4.7 | Play Data Safety: «تعمل في الخلفية» | **MISSING** | بند في النموذج غير المُعبّأ (§6) |

---

## 5. الإشعارات

| # | البند | الحالة | ملاحظة |
|---|---|---|---|
| 5.1 | إعلان `POST_NOTIFICATIONS` (التطبيقان) | `PRESENT` | كلا الـ Manifest |
| 5.2 | طلب الإذن وقت التشغيل — **الوالد** | `PRESENT` | `push_registration_service.dart:60` ⇒ `messaging.requestPermission()` |
| 5.3 | طلب الإذن وقت التشغيل — **الطفل** | **MISSING** ⚠️ | `PermissionManager.kt` يقرأ الحالة (`areNotificationsGranted`) ويقول في تعليقه الخاص إن موضع الطلب «يخصّ `MainActivity` أو شاشة onboarding مستقبلية». وفحص `MainActivity.kt`: **لا `requestPermissions` فيه إطلاقًا.** الأثر على Android 13+: الإذن **لا يُطلَب أبدًا**، فإشعار الخدمة الدائم وتنبيه «الحماية متوقفة» **لا يظهران** ما لم يفتح الأهل الإعدادات يدويًا. **ليس حاجز متجر — لكنه عطل وظيفي حقيقي**، وهو مسجَّل هنا لأن §28 يسأل عن «notification permissions» لا عن إعلانها فقط |
| 5.4 | Firebase / FCM مُهيّأ | **HUMAN DECISION** | لا `google-services.json`. التفاصيل الكاملة في `FIREBASE_SETUP.md`. بدونه: **لا يصل إشعار push واحد للوالد** |

---

## 6. Data Safety — مشتقّة من **ما يُرسَل فعلًا**، لا من وصفٍ له

### 6.1 الحقول التسعة من جهاز الطفل

مقروءة من `apps/child-app/lib/plugins/screen_time/application/digital_wellbeing_service.dart`
(‏حمولة `daily-summary`)، لا من وثيقة تصفها:

| # | الحقل | ما هو | فئة Data Safety |
|---|---|---|---|
| 1 | `usageDate` | تاريخ الملخّص | App activity |
| 2 | `totalScreenMinutes` | إجمالي دقائق الشاشة | App activity |
| 3 | `appBreakdown[]` | لكل تطبيق: `packageName` + `minutes` + `category` | **App activity — app interactions** |
| 4 | `pickupCount` | مرات إحضار تطبيق للمقدّمة | App activity |
| 5 | `nightUsageMinutes` | دقائق الاستخدام في `{22,23,0..5}` | App activity |
| 6 | `blockedAttemptCount` | مرات فتح تطبيق خارج الخطة | App activity |
| 7 | `sessionCount` | عدد الجلسات | App activity |
| 8 | `averageSessionMinutes` | متوسط طول الجلسة | App activity |
| 9 | `longestSessionMinutes` | أطول جلسة | App activity |

**لا يغادر الجهاز:** محتوى شاشة · نصّ مكتوب · رسائل · جهات اتصال · موقع
جغرافي · صوت · صور. وهذا **مضمون بنيويًا** لا وعدًا: `canRetrieveWindowContent=false`.

### 6.2 ما لم تكن الحقول التسعة تغطّيه — وهو مطلوب في النموذج نفسه

النموذج يسأل عن **كل** ما يُجمَع، لا عن ملخّص الاستخدام وحده:

| المصدر | الحقول | فئة Data Safety | الحالة |
|---|---|---|---|
| تسجيل الوالد (`auth_api.dart`) | `fullName` · `email` · `password` | **Personal info — name, email** · **Credentials** | `PRESENT` في الكود، **MISSING** في النموذج |
| إنشاء ملف طفل (`dashboard_api.dart`) | `firstName` · `lastName` · **`dateOfBirth`** | **Personal info — name** · **تاريخ ميلاد قاصر** | نفسه |
| اقتران الجهاز (`pairing_api.dart`) | `publicKey` · `platform` · `deviceModel` · `osVersion` · `appVersion` | **Device or other IDs** | نفسه |
| النبضة (‏heartbeat) | `batteryPercent` · `isConnected` · حالة الأذونات | **App info and performance** | نفسه |
| إشارات العبث (`critical_event_coordinator.dart`) | `ACCESSIBILITY_DISABLED` · `PROTECTION_BYPASS_ATTEMPT` | **App activity** | نفسه |
| Sentry | تقارير الأعطال | **Crash logs** — فئة صريحة في النموذج | نفسه |
| FCM | رمز الجهاز | **Device or other IDs** | مشروط بـ §5.4 |

| # | البند | الحالة |
|---|---|---|
| 6.a | نموذج Data Safety مُعبّأ في Play Console | **MISSING** — **حاجز رفع** |
| 6.b | النموذج يطابق ما ترسله الشبكة حرفيًا | **MISSING** | أي تعارض = إزالة من المتجر، لا تحذير |
| 6.c | فحص آلي يربط الحمولة بنصّ الإفصاح | **MISSING** | حقل يُضاف غدًا يجعل الشاشة **والنموذج** كاذبَين بصمت. مرشّح لفحص CI، ولم يُبنَ (مسجَّل منذ F2) |
| 6.d | شاشة الإفصاح البارز داخل التطبيق | `PRESENT` | `prominent_disclosure_screen.dart` — قبل الاقتران وقبل أي إذن، وتسمّي الحقول التسعة |
| 6.e | ربط الموافقة بـ `ParentalConsent` في الـ backend | **MISSING** | الشاشة تكتب **محليًا فقط** (`SharedPreferences`). حاجز **قانوني** لا تقني |

---

## 7. الفئة العمرية وتصنيف المحتوى

| # | البند | الحالة | ملاحظة |
|---|---|---|---|
| 7.1 | استبيان تصنيف المحتوى (IARC) | **MISSING** | نموذج Console، لا شيء منه في الريبو |
| 7.2 | **Target Audience & Content** — الجمهور ٦–١٧ | **HUMAN DECISION** ثم **MISSING** | إعلان جمهور يشمل قاصرين ⇒ **Families policy** كاملة + مراجعة إضافية. القرار بشري، والنموذج ناقص |
| 7.3 | تطبيق الطفل ضمن **Designed for Families** | **HUMAN DECISION** | يقيّد المكتبات والإعلانات وواجهات الشراء |
| 7.4 | لا إعلانات ولا SDK تتبّع إعلاني | `PRESENT` (‏مؤكَّد) | `pubspec.yaml` للتطبيقين: لا AdMob، لا Facebook SDK، لا analytics إعلاني. التبعيات الخارجية: `dio` · `riverpod` · `shared_preferences` · `flutter_secure_storage` · `google_fonts` · `sentry_flutter` (+ `firebase_*` و`connectivity_plus` للوالد) |
| 7.5 | COPPA / GDPR-K / رأي قانوني (مصر، السعودية) | **HUMAN DECISION** | مهلة متوقّعة ٤–٨ أسابيع ⇒ **يبدأ الآن، لا عند التقديم** |

---

## 8. حذف الحساب

| # | البند | الحالة | الدليل |
|---|---|---|---|
| 8.1 | مسار حذف **داخل التطبيق** | `PRESENT` | `delete_account_screen.dart` ⇒ `accountApiProvider.deleteAccount(password)`، بتأكيد + كلمة مرور |
| 8.2 | **رابط ويب عام** لطلب الحذف | **MISSING** | Play يطلب **الاثنين** منذ 2023: مسار داخل التطبيق **و**رابط يعمل بلا تثبيت التطبيق. **حاجز رفع** |
| 8.3 | بيان ما يُحذف ومدى الاحتفاظ | **HUMAN DECISION** | نصّ قانوني — لم يُختلَق هنا |
| 8.4 | حذف من جهة الطفل | `N/A` بتصميم | جهاز الطفل مقترن ولا يملك حسابًا؛ الحذف بيد الوالد. **يجب أن يُذكر هذا في النشرة** حتى لا يُقرأ كغياب |

---

## 9. الاشتراكات والمدفوعات — **أكبر فجوة سياسة في هذه الوثيقة**

| # | البند | الحالة | الدليل |
|---|---|---|---|
| 9.1 | شاشات الاشتراك | `PRESENT` | `subscription_screen.dart` · `billing_history_screen.dart` · `redeem_code_screen.dart` |
| 9.2 | **Google Play Billing** | **MISSING** ⚠️ | لا `in_app_purchase` ولا `billing_client` في `pubspec.yaml`، ولا `com.android.billingclient` في `build.gradle`، ولا `com.android.vending.BILLING` في الـ Manifest. الشاشة تستدعي `billingApi.subscribe(planTier, 'MANUAL')` — أي **مزوّد باسم `MANUAL`** |
| 9.3 | الأثر | **HUMAN DECISION، وحاجز** | سياسة Play: بيع محتوى رقمي داخل التطبيق **يجب** أن يمرّ بـ Play Billing. تطبيق يبيع اشتراكًا بمسار خارجي يُرفض أو يُزال. المخارج المشروعة (اشتراك يُباع خارج التطبيق فقط، أو تصنيف مختلف) **قرارات تجارية**، لا تعديلات كود |
| 9.4 | بيانات وصف المنتجات (‏SKU، سعر، دورة) | **MISSING** | تُنشأ في Console، ويجب أن تطابق `getPlans()` |
| 9.5 | «استعادة المشتريات» | **MISSING** | يتبع 9.2 |

---

## 10. الروابط الإلزامية

| # | البند | الحالة | الدليل |
|---|---|---|---|
| 10.1 | سياسة خصوصية على URL عام | **MISSING** | **حاجز رفع مزدوج** (تطبيق + تطبيق أطفال). **الكود جاهز لها:** `child-app/core/config/app_config.dart` يعلن `PRIVACY_POLICY_URL` بافتراضي **فارغ**، والشاشة **تُخفي الرابط بدل عرض رابط ميت** — قرار صحيح |
| 10.2 | نفس الشيء في تطبيق الوالد | **MISSING** | ولا يوجد حتى **مفتاح** له: لا `PRIVACY_POLICY_URL` ولا `TERMS_URL` في `parent-app/core/config/app_config.dart`. أي أن الوالد ينقصه **الرابط والمكان الذي يوضع فيه** |
| 10.3 | شروط الاستخدام | **MISSING** | `register_screen.dart` يرسل `acceptedTerms` — أي أن المستخدم يوافق على **شروط لا وجود لها** |
| 10.4 | دعم: بريد + رابط | جزئي | `contact_support_screen.dart` ⇒ نموذج داخلي إلى `supportApi.submitRequest`. Play يطلب **بريد دعم** في النشرة: **HUMAN DECISION** |
| 10.5 | عنوان المطوّر وبياناته | **HUMAN DECISION** | كيان تجاري وحساب Play Console |

---

## 11. البناء والتوقيع

| # | البند | الحالة | الدليل |
|---|---|---|---|
| 11.1 | تهيئة توقيع الإصدار | **MISSING** ⚠️ | `buildTypes { release { signingConfig signingConfigs.debug } }` في **التطبيقين**. مقصود ومعلَّق عليه، لكن **APK موقَّع بمفتاح debug لا يُقبَل على Play إطلاقًا** |
| 11.2 | مفتاح upload / Play App Signing | **HUMAN DECISION** | إنشاء المفتاح وحفظه. **فقدانه يعني فقدان القدرة على التحديث** |
| 11.3 | AAB لا APK | **MISSING** | Play يطلب `.aab` للتطبيقات الجديدة. الـ workflow يبني `apk` فقط — مناسب للاختبار، **غير قابل للرفع** |
| 11.4 | `targetSdk` يطابق حدّ Play | ⚠️ `PRESENT` = 34 | مقبول اليوم؛ حدّ Play يتقدّم سنويًا وAGP 8.1.1 **يرفض ما فوق 34** — أي أن رفع `targetSdk` يستلزم رفع AGP وGradle وFlutter معًا |
| 11.5 | `pubspec.lock` ملتزَم | **MISSING** | البناء يتبع تاريخًا لا commit (‏PA-M-016). خطوة واحدة، موصوفة في `FLUTTER_CI_RUNBOOK.md §1.2` |
| 11.6 | تعتيم / R8 لبناء الإصدار | غير مُهيّأ | لا `minifyEnabled` ولا `proguard-rules.pro`. **ليس حاجزًا**، ويستحق قرارًا قبل الإصدار |

---

## 12. الحصيلة

| الحالة | العدد |
|---|---|
| `PRESENT` | **27** |
| `MISSING` | **22** |
| `HUMAN DECISION` | **14** |

**الحواجز التي لا يمكن لأي كمية كود أن ترفعها** (‏بالترتيب الذي يجب أن تُبدأ به،
لأن اثنين منها لهما مهلة خارجية):

1. **الرأي القانوني ونصوص الخصوصية/الشروط** (§10، §7.5) — ٤–٨ أسابيع. **يبدأ أولًا.**
2. **حسم اسم الحزمة** (§1.1–1.2) — يحكم Firebase ويستحيل تغييره بعد أول نشر.
3. **قرار Play Billing** (§9) — قد يغيّر بنية المنتج، لا سطرًا فيه.
4. **حساب Play Console + مفتاح التوقيع + AAB** (§11).
5. **نموذج Data Safety + إعلان الأذونات + فيديو demo** (§6، §3) — يحتاج APK يعمل.

**والحاجز فوق كل هؤلاء:** لا يوجد artifact. `docs/release/WINDOWS_DEV_SETUP.md`
و`.github/workflows/build-apk.yml` هما الطريقان إلى أول واحد.

---

## افتراضات ومخاطر مفتوحة

1. **لا شيء هنا اختُبر على جهاز أو على Play Console.** كل صفّ `PRESENT` يعني
   «الملف موجود في الشجرة وقُرئ»، **لا** «يعمل». صفر `TESTED`.
2. **الحقول التسعة قُرئت من الكود اليوم.** لا يوجد اختبار يربط الحمولة بنصّ
   الإفصاح ولا بالنموذج، فأي حقل يُضاف غدًا يجعل الثلاثة متعارضة **بصمت** —
   وهذا هو بالضبط السبب الذي يُزال به تطبيق من المتجر. §6.c مرشّح لفحص CI،
   ولم يُبنَ في هذه الجولة.
3. **§6.2 قد يكون ناقصًا.** جُمع بقراءة طبقات الـ API في التطبيقين؛ أي مسار
   يرسل حقلًا لم أقرأه يجعل النموذج ناقصًا. **قائمة الحقول النهائية يجب أن
   تُولَّد من الكود، لا تُكتب بيدٍ** — بما فيها هذه.
4. **«27 / 22 / 14» عدّ لبنود اخترتُ أنا حدودها.** بند يُقسَّم قسمين يغيّر
   الأرقام دون أن يغيّر الواقع. **الحواجز الخمسة أعلاه هي المحتوى؛ الأرقام
   ملخّص.**
5. **لم أقرأ سياسات Google الحالية في هذه الجلسة** — الشبكة محجوبة (`000` على
   كل مضيف خارجي). ما أعلاه مبني على السياسات كما هي معروفة حتى تاريخ
   الوثيقة، **وسياسات Play تتغيّر**. يجب التحقّق من كل بند مقابل نصّ
   السياسة المنشور وقت التقديم.
6. **لا نصّ قانوني هنا، ولا واحد.** حيث لزم، الصفّ يقول `HUMAN DECISION`
   ويقف. اختلاق فقرة خصوصية أسوأ من غيابها: الغياب مرئي، والاختلاق يُوقَّع.
7. **‏`isAccessibilityTool="false"` قرار واعٍ** يفتح المراجعة اليدوية.
   تغييره لتفادي المراجعة **غشّ في التصنيف** ويستدعي إزالة دائمة. لا يُلمَس.
