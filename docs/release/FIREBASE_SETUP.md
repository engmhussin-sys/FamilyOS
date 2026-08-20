# `google-services.json` — قرار مطلوب من العميل (Firebase / FCM)

| Document ID | Version | Owner Role | Status | Last Updated |
|---|---|---|---|---|
| REL-FIREBASE-001 | 1.0 | Mobile Release Lead | **USER DECISION REQUIRED** | 2026-08-15 |

> **لا يوجد في هذا المستودع ملف `google-services.json`، ولن يُختلَق واحد.**
> ملف مزيَّف يُنتج APK تفشل فيه الإشعارات **بصمت** — وهذا بالضبط الـ false
> green الذي يمنعه `CONTEXT §3.9`. ما يلي قرار، لا اختراع.

---

## 1. لماذا هو مطلوب أصلًا

| الطبقة | ما تفعله | ماذا يحدث بلا الملف |
|---|---|---|
| `apps/parent-app/pubspec.yaml` | يعلن `firebase_core: ^3.6.0` و`firebase_messaging: ^15.1.3` كتبعيتين حقيقيتين | لا شيء وقت البناء — الـ AAR يُنزَّل عاديًا |
| `android/settings.gradle` | يعلن `com.google.gms.google-services` version `4.4.2` بـ `apply false` | لا شيء |
| `android/app/build.gradle` | **كان** يطبّق الـ plugin بلا شرط | كان يفشل البناء كليًا: `File google-services.json is missing` |
| `lib/core/notifications/push_registration_service.dart` | `Firebase.initializeApp()` ثم `FirebaseMessaging.instance.getToken()` | يرمي وقت التشغيل، والاستثناء **مُلتقَط أصلًا** (`try/catch` قائم منذ Sprint 5) |

الخلاصة المهمة: **الـ Dart لم يكن هو المانع أبدًا.** المانع كان سطرًا
واحدًا في Gradle. لهذا كان فكّ الارتباط ممكنًا وآمنًا.

---

## 2. القرار المنفَّذ في Phase C — فكّ الارتباط خلف flag

`apps/parent-app/android/app/build.gradle` صار يطبّق الـ plugin **شرطيًا**:

| `-Pabny.firebase=` | السلوك |
|---|---|
| `auto` (**الافتراضي**) | يطبّق الـ plugin **إن وُجد** `google-services.json`؛ وإلا يطبع تحذيرًا صريحًا ويكمل |
| `required` | **يفشل** البناء إن غاب الملف — وهذا ما **يجب** أن تستخدمه بناءات الـ release |
| `off` | لا يطبّق الـ plugin إطلاقًا |

وعلى جانب Dart، `--dart-define=ENABLE_PUSH=false` يجعل الحالة **مقروءة في
السجل** بدل أن تبدو كعطل Firebase عابر. الافتراضي `true`؛ لم يُحذف أي سلوك.

### ماذا يُفقَد بالضبط بلا الملف — بصراحة

- **لا FCM registration token** ⇒ `POST /pairing/parent-device/push-token`
  لا يُستدعى ولا مرة، والـ backend لا يملك جهازًا يدفع إليه.
- **لا إشعار push واحد يصل للوالد.** الرحلة **J8** («الوالد يستقبل إشعارًا ذا
  معنى») والرحلة **J10** **غير قابلتين للاختبار** على هذا الـ artifact.
- `Firebase.initializeApp()` يرمي، ويُلتقَط، ويكمل التطبيق.

### ماذا **لا** يُفقَد

كل ما عدا ذلك: التسجيل، الدخول، الاقتران، الأسرة، الأطفال، السياسات، سطح
F4 كاملًا (الأهداف والمراجعة والتسليم والمكافآت) — و**APK debug حقيقي قابل
للتثبيت**، وهو الشيء الذي كان محجوبًا كليًا قبل هذا التغيير.

### هل هو عكوس؟

نعم، وذاتيًا. ضع `google-services.json` في `apps/parent-app/android/app/`
(أو اضبط الـ secret أدناه فيكتبه الـ workflow في المسار نفسه) — يُطبَّق
الـ plugin تلقائيًا في التشغيلة التالية **بلا أي تعديل كود**.

---

## 3. ما يحتاجه العميل — قائمة دقيقة

### 3.1 المشروع

مشروع Firebase **واحد** يكفي للتطبيقين (Android app منفصل داخل نفس المشروع
لكل حزمة). لا يوجد اسم مشروع مفروض هنا — **هذا قرار العميل**، وأيّ اسم
نخترعه سيكون كذبًا. الاختيار الطبيعي: نفس المشروع الذي يملك الـ **service
account** الذي يستخدمه الـ backend في `PushNotificationService`، وإلا فالوالد
يسجّل token في مشروع والـ backend يدفع من مشروع آخر — ولن يصل شيء، بلا خطأ.

> **تحقّق إلزامي:** `project_id` داخل `google-services.json` **يجب** أن يطابق
> `project_id` في مفتاح الـ service account على الـ backend.

### 3.2 أسماء الحزم — بالضبط، كما هي في الشجرة اليوم

| التطبيق | `applicationId` / `namespace` | مصدر الحقيقة |
|---|---|---|
| **Parent** | `com.aifamilycoach.parent_app` | `apps/parent-app/android/app/build.gradle` |
| **Child** | `com.aifamilycoach.child_app` | `apps/child-app/android/app/build.gradle` |

> ⚠️ **يتقاطع مع blocker رقم 8 في `PHASE_B §19`** (إعادة التسمية إلى
> `EBNEY`). تغيير `applicationId` بعد أول نشر على Play **مستحيل عمليًا**،
> و`google-services.json` مربوط بالحزمة. **قرّر الاسم قبل إنشاء تطبيق
> Firebase، لا بعده** — وإلا كرّرت العملية.
>
> ملاحظة: تطبيق الطفل **لا يعتمد** `firebase_messaging` اليوم (راجع
> `apps/child-app/pubspec.yaml`)، فلا يحتاج الملف حاليًا. أنشئ تطبيق
> Firebase له فقط إن كان push للطفل (J10) في نطاق هذه المرحلة.

### 3.3 بصمات SHA — أيها مطلوب فعلًا

| البصمة | مطلوبة لـ | مطلوبة الآن؟ |
|---|---|---|
| **SHA-1** | Google Sign-In · Dynamic Links · Phone Auth | ❌ لا — المشروع يستخدم JWT خاصًّا به |
| **SHA-256** | App Check · Play Integrity | ❌ ليس للـ MVP |
| **لا شيء** | **FCM وحده** | ✅ **FCM لا يحتاج بصمة إطلاقًا** |

**النتيجة العملية: لتشغيل الإشعارات فقط، لا تحتاج أيّ بصمة.** هذا يزيل
اعتمادًا كان مفترضًا. إن أُضيف Google Sign-In لاحقًا، فالأمر:

```bash
# مفتاح الـ debug (نفسه على كل جهاز مطوّر — ليس سرًّا)
keytool -list -v -alias androiddebugkey \
  -keystore ~/.android/debug.keystore -storepass android -keypass android

# مفتاح الـ upload/release الحقيقي
keytool -list -v -alias <your-alias> -keystore <path-to-upload-keystore.jks>

# أو، الأدقّ بعد النشر — لأن Play يعيد التوقيع بمفتاحه هو:
# Play Console > Release > Setup > App integrity > App signing key certificate
```

> عند تفعيل Play App Signing، **بصمة Play هي المهمة**، لا بصمة الـ upload key.
> هذا يُنسى دائمًا ويُنتج عطلًا يظهر في الإنتاج فقط.

### 3.4 هل Firebase Messaging مطلوب لبناء **debug**؟

**لا.** بعد تغيير Phase C:

| البناء | يحتاج `google-services.json`؟ |
|---|---|
| `flutter build apk --debug` | **لا** — يُنتج APK حقيقيًا، بلا push |
| `flutter build apk --release` | **نعم، عمليًا** — والـ workflow يرفض المحاولة بدونه |
| `flutter analyze` / `flutter test` | **لا** — لا يمسّان Gradle أصلًا |

---

## 4. الخطوات — بالترتيب

1. **احسم اسم الحزمة** (`abny` مقابل `ebney`) — راجع `PHASE_B §19` بند 8.
2. Firebase Console ⇒ Add app ⇒ **Android** ⇒ package
   `com.aifamilycoach.parent_app` (أو الاسم المحسوم). اترك حقل SHA-1 فارغًا.
3. نزّل `google-services.json`.
4. تأكد أن `project_id` فيه = `project_id` في service account الـ backend.
5. GitHub ⇒ Settings ⇒ Secrets and variables ⇒ Actions ⇒ **New repository
   secret** باسم `GOOGLE_SERVICES_JSON`، وألصق **الملف كاملًا** (لا Base64 —
   الـ workflow يكتبه كما هو عبر `printf '%s'`).
6. أعد تشغيل `.github/workflows/build-apk.yml`. الملخّص سيقول
   `Firebase: enabled`.

**لا تلتزم الملف في git.** ليس سرًّا شديد الحساسية (يُستخرج من أي APK)، لكن
الـ secret يبقيه بعيدًا عن الـ forks ويجعل تدويره لحظيًا.

---

## 5. كيف تتحقق أن الأمر نجح فعلًا

| # | التحقق | الدليل المتوقَّع |
|---|---|---|
| 1 | ملخّص الـ CI | `Firebase: enabled` بدل `absent` |
| 2 | سجل Gradle | `ABNY: google-services.json found — Firebase Messaging is ENABLED.` |
| 3 | داخل الـ APK | `res/values/values.xml` يحوي `google_app_id` |
| 4 | وقت التشغيل | لا `debugPrint` من `PushRegistrationService` بعد الدخول |
| 5 | الـ backend | صف في `parent_devices` بـ `pushToken` غير فارغ بعد أول دخول |
| 6 | الرحلة J8 | إشعار حقيقي يصل بعد `REWARD_GRANTED` |

**البند 6 وحده هو الدليل.** البنود 1–5 تثبت أن الإعداد تمّ، لا أن الإشعار وصل.

---

## افتراضات ومخاطر مفتوحة

1. **`applicationId` غير محسوم.** كل ما فوق مبني على
   `com.aifamilycoach.parent_app` كما هو في الشجرة اليوم. حسم `EBNEY` بعد
   إنشاء تطبيق Firebase يعني إعادة الخطوات 2–6.
2. **تطابق المشروع بين العميل والـ backend غير متحقَّق منه آليًا.** لا يوجد
   اليوم فحص يقارن `project_id` في الملف بمفتاح الـ backend. عدم تطابقهما
   ينتج نظامًا **صامتًا لا معطلًا** — الوالد يظنّ الإشعارات تعمل. مرشّح جيّد
   لفحص CI لاحق، ولم يُبنَ هنا.
3. **زعم «FCM لا يحتاج SHA» مبني على وثائق Firebase، ولم يُختبر هنا** — لا
   يوجد مشروع Firebase ولا شبكة إلى Google من بيئة التأليف. إن رفض الـ
   Console المتابعة بلا بصمة، فالأمر في §3.3 هو المخرج.
4. **إشعارات الطفل (J10) خارج نطاق هذا المستند.** `apps/child-app` لا يعتمد
   `firebase_messaging` اليوم؛ إضافته تبعية جديدة وقرار منفصل.
5. **لم يُبنَ ولا APK واحد للتحقق من أيٍّ مما سبق.** كل ما هنا `STATIC
   VERIFIED`: قُرئت ملفات Gradle، وحُلِّلت شرطية تطبيق الـ plugin، وتأكّد أن
   ملفات Gradle الستة **تُحلَّل نحويًا** بـ Groovy parser حقيقي. **لم يُشغَّل
   Gradle، ولا Flutter، ولا أُنتج artifact.**
