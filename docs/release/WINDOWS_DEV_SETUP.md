# إعداد جهاز Windows حقيقي لبناء «ابني» / ABNY

| Document ID | Version | Owner Role | Status | Last Updated |
|---|---|---|---|---|
| REL-WIN-DEV-001 | 1.0 | Mobile Release Lead | `STATIC VERIFIED` — **لم يُشغَّل السكربت ولا مرة** | 2026-08-17 |

> **إفصاح أول، قبل أي شيء:** بيئة التأليف لا تحوي `flutter` ولا `dart` ولا
> Android SDK، و`storage.googleapis.com` و`dl.google.com` و`pub.dev` و
> `services.gradle.org` تردّ **`000/BLOCKED`** على الـ `CONNECT`. فـ
> `scripts/setup-windows-dev.ps1` **مكتوب ليُشغَّل على جهازك، ولم يُشغَّل هنا**.
> أول تشغيلة على جهاز حقيقي هي **أول قياس**، وما دونها تقدير.

---

## 1. الأمر الواحد

```powershell
git clone <repo> FamilyOS
cd FamilyOS
powershell -ExecutionPolicy Bypass -File scripts\setup-windows-dev.ps1
```

هذا يفعل، بالترتيب: تثبيت **Flutter SDK** المثبَّت في الـ workflow، و**JDK**
المطابق، و**Android SDK command-line tools**، ثم **platform** و**build-tools**
اللذين تطلبهما ملفات Gradle، ثم قبول التراخيص، ثم `flutter doctor -v`، ثم
**للتطبيقين معًا**:

```
flutter pub get  →  flutter analyze  →  flutter test  →  flutter build apk --debug
```

ثم يطبع جدول نجاح/فشل واحدًا ومسار كل APK.

**لا يحتاج صلاحية مسؤول**، ولا يكتب داخل `Program Files`؛ كل شيء تحت
`C:\abny-dev` (يُغيَّر بـ `-InstallRoot`).

### 1.1 مفاتيح مفيدة

| المفتاح | متى |
|---|---|
| `-SkipInstall` | التشغيلة الثانية فصاعدًا — يتخطّى كل تنزيل ويشغّل الأوامر الأربعة فقط |
| `-Apps child-app` \| `parent-app` \| `both` | تضييق النطاق |
| `-SkipTests` | تخطّي `flutter test` وحده |
| `-ApiBaseUrl http://192.168.1.20:3000/api/v1` | **لازم على جهاز فعلي** — انظر §5 |
| `-InstallRoot D:\tools\abny` | مكان آخر للتوليتشين |
| `-BuildToolsVersion 34.0.0` | تجاوز الاشتقاق الوحيد غير المأخوذ من الريبو (§3) |

**السكربت idempotent:** كل خطوة تركيب تفحص ناتجها أولًا وتتخطّاه إن كان
موجودًا وصحيحًا. إعادة التشغيل بعد فشل تنزيل **تُكمل** ولا تبدأ من الصفر،
وإعادة التشغيل على جهاز سليم تكلّف ثوانيَ ولا تغيّر شيئًا.

---

## 2. لماذا هذه الأرقام بالذات — **كلها مقروءة من الريبو وقت التشغيل**

لا يوجد في السكربت رقم واحد مكتوب من الذاكرة. الدالّة `Get-RepoPins` تقرأ:

| المكوّن | القيمة اليوم | من أين قُرئت حرفيًا |
|---|---|---|
| Flutter SDK | **3.24.5** | `.github/workflows/build-apk.yml` ⇒ `env.FLUTTER_VERSION` |
| JDK | **17** | `.github/workflows/build-apk.yml` ⇒ `env.JAVA_VERSION` |
| Gradle | **8.3** | `apps/*/android/gradle/wrapper/gradle-wrapper.properties` ⇒ `distributionUrl` |
| AGP | **8.1.1** | `apps/*/android/settings.gradle` ⇒ `id "com.android.application" version` |
| Kotlin | **1.9.10** | `apps/*/android/settings.gradle` ⇒ `id "org.jetbrains.kotlin.android" version` |
| `compileSdk` | **34** | `apps/*/android/app/build.gradle` |
| `targetSdk` | **34** | نفس الملف |
| `minSdk` | **21** | نفس الملف |
| Dart SDK constraint | **`>=3.3.0 <4.0.0`** | `apps/*/pubspec.yaml` ⇒ `environment.sdk` |
| `API_BASE_URL` (debug) | **`http://10.0.2.2:3000/api/v1`** | `apps/*/lib/core/config/app_config.dart` ⇒ `debugDefaultApiBaseUrl` |

**والتطبيقان يُقرآن منفصلين ثم يُقارَنان.** إن اختلفا في أي قيمة مثبَّتة
**يتوقّف السكربت** بدل أن يختار أحدهما — لأن توليتشين واحدًا لا يرضي رقمين
مختلفين، والانحراف الصامت بين التطبيقين هو بالضبط العطل الذي كُتب هذا الملف
لمنعه.

### 2.1 لماذا JDK 17 ولا شيء غيره

ثلاثة قيود مستقلّة، كلها في الريبو:

1. `gradle-wrapper.properties` يثبّت **Gradle 8.3**، و Gradle لم يكتسب القدرة
   على **العمل** على JDK 21 إلا في 8.5 — فعلى JDK أحدث يموت البناء بـ
   `Unsupported class file major version 65` قبل ترجمة سطر واحد.
2. `settings.gradle` يثبّت **AGP 8.1.1**، وهو يريد 17.
3. `app/build.gradle` يعلن `sourceCompatibility`/`targetCompatibility` = **17**.

**17 وحده يرضي الثلاثة.** (للعلم: بيئة التأليف عليها JDK 21 و Gradle 8.14.3 —
أي أنها **لا تصلح** لبناء هذا الريبو حتى لو وُجد فيها Flutter.)

---

## 3. الأرقام الثلاثة التي **ليست** في الريبو — مذكورة بالاسم

الأمانة هنا أهم من اكتمال الجدول:

1. **`build-tools`.** لا يوجد `buildToolsVersion` في أيٍّ من ملفَّي
   `app/build.gradle`، فـ AGP يختار افتراضه بنفسه. السكربت يركّب
   **`build-tools;<compileSdk>.0.0`** — أي `34.0.0` اليوم — وهو **اشتقاق من
   `compileSdk` المقروء من الريبو، لا رقم محفوظ**، ويطبع أنه اشتقّه.
   تجاوزه بـ `-BuildToolsVersion`.
2. **نسخة حزمة `commandlinetools`.** هذه **المُثبِّت**، لا مُدخَل بناء: كل
   وظيفتها توفير `sdkmanager` الذي يركّب بعدها الأرقام التي تهمّ فعلًا.
   تجاوزها بـ `-CmdlineToolsUrl`.
3. **`ndkVersion`.** الملفّان يُبقيانه عمدًا على `flutter.ndkVersion` (السبب
   موثَّق في تعليق `build.gradle` نفسه: تثبيت رقم خاطئ يفشل كخطأ تنزيل غامض).
   ولذلك **لا يركّب السكربت أي NDK**. بناء debug لهذين التطبيقين لا يحتاجه؛
   وإن احتاجه plugin يومًا، فسيقولها Gradle بالاسم.

---

## 4. ما الذي يبقى **يدويًا** بعد نجاح السكربت

### 4.1 `pubspec.lock` — إلزامي مرّة واحدة

لا يوجد `pubspec.lock` مُلتزَم في أيٍّ من التطبيقين، وكل قيد تبعية `^caret`.
فالبناء **يتبع تاريخًا لا commit**. بعد أول `flutter pub get` ناجح:

```powershell
git add apps/parent-app/pubspec.lock apps/child-app/pubspec.lock
git commit -m "chore(mobile): pin resolved dependency graph (PA-M-016)"
```

فور وجودهما يتحوّل **السكربت والـ CI معًا** تلقائيًا إلى
`flutter pub get --enforce-lockfile`، فيصير البناء حتميًا وأي انحراف يفشل بصوت.

### 4.2 `google-services.json` — **قرار العميل، ولا يُختلَق**

بلا هذا الملف يُبنى **APK حقيقي قابل للتثبيت** لتطبيق الوالد، لكن:

- **لا FCM token**، فـ `POST /pairing/parent-device/push-token` لا يُستدعى؛
- **لا يصل إشعار push واحد للوالد**؛ الرحلتان **J8** و**J10** غير قابلتين
  للاختبار على هذه النسخة؛
- كل ما عدا ذلك يعمل.

السكربت يكتشف غيابه، يطبع الإنذار أعلاه، ويمرّر `--dart-define=ENABLE_PUSH=false`
ليكون الأمر **مقروءًا في السجل** بدل أن يشبه عطل Firebase عابرًا.
**لا placeholder، ولا credential، ولا project id مُختلَق.** التفاصيل الكاملة:
`docs/release/FIREBASE_SETUP.md`.

---

## 5. الفخّ الوحيد المتوقَّع على جهاز فعلي — `10.0.2.2`

الافتراضي `http://10.0.2.2:3000/api/v1` هو **alias المحاكي (emulator) لجهاز
المضيف**. على هاتف فعلي **هذا العنوان غير موجود** والتطبيق سيبدو «لا يتصل»
بلا رسالة مفيدة. الحل:

```powershell
.\scripts\setup-windows-dev.ps1 -SkipInstall -ApiBaseUrl http://192.168.1.20:3000/api/v1
```

وتأكّد أن الـ host مذكور في قائمة الـ cleartext في
`android/app/src/debug/res/xml/network_security_config.xml` — القائمة اليوم:
`10.0.2.2` · `10.0.3.2` · `127.0.0.1` · `localhost` · `abny-dev.local`.
وإلا **يرفض Android الاتصال** ولا يملك التطبيق ما يعرضه.

> `--dart-define=API_BASE_URL` **إلزامي في كل بناء في هذا الريبو**
> (audit MA-004): بدونه يُثبَّت الـ APK ولا يستطيع مخاطبة أي شيء، وartifact
> لا يستطيع أحد تسجيل الدخول إليه ليس دليلًا.

---

## 6. أين تذهب المخرجات

```
build-logs\flutter-doctor.txt
build-logs\<app>-pubget.txt   <app>-analyze.txt   <app>-test.txt   <app>-build.txt
apps\<app>\build\app\outputs\flutter-apk\app-debug.apk
```

التثبيت على جهاز موصول:

```powershell
adb devices
adb install -r "apps\child-app\build\app\outputs\flutter-apk\app-debug.apk"
```

**السكربت diagnostic-first مثل الـ CI:** كل مرحلة تعمل ويُسجَّل ناتجها **حتى
لو فشلت سابقتها**، فتشغيلة واحدة تقول كل ما هو معطوب لا أوّله. الاستثناء
الوحيد `pub get`: إن فشل حلّ التبعيات فلا شيء بعده يعلّمنا شيئًا، فيُقصَّر
مسار ذلك التطبيق ويُقال ذلك صراحة.

---

## 7. إن فشل شيء — الفشل المتوقَّع، بالاسم

| العرض | السبب الأرجح | العلاج |
|---|---|---|
| `Unsupported class file major version 65/67` | JDK غير 17 التُقط من `JAVA_HOME` أو من PATH | افتح terminal **جديدًا** بعد التركيب؛ السكربت يضبط `JAVA_HOME` على مستوى المستخدم |
| `compileSdk 35 requires AGP 8.6.0 or higher` | نسخة Flutter غير 3.24.5 | `-SkipInstall` أُعطي وflutter على الـ PATH نسخة أخرى — السكربت يُنذر بذلك في §6 من مخرجاته |
| `flutter.sdk not set in local.properties` | أول أمر Gradle نُفِّذ خارج أداة Flutter | شغّل `flutter build apk --debug` من مجلد التطبيق؛ الأداة تكتب الملف |
| `Some Android licenses not accepted` | مسار قبول واحد فقط نُفِّذ | السكربت يشغّل المسارين (`sdkmanager --licenses` و`flutter doctor --android-licenses`) — أعد تشغيله بلا `-SkipInstall` |
| `Could not determine SDK root` من `sdkmanager` | تخطيط `cmdline-tools/latest/` غير صحيح | السكربت ينشئه صحيحًا؛ إن ركّبتَ يدويًا فانقل المجلد إلى `<sdk>\cmdline-tools\latest\` |
| فشل التنزيل من `storage.googleapis.com` | شبكة/بروكسي الشركة | نزّل الأرشيف يدويًا إلى `<InstallRoot>\downloads\` بنفس الاسم؛ السكربت يلتقط الملف الموجود ولا يعيد تنزيله |

---

## افتراضات ومخاطر مفتوحة

1. **لم يُشغَّل هذا السكربت ولا مرة.** فُحص **بنيويًا** فقط: توازن الأقواس
   والاقتباسات، وأن كل دالّة مستعملة معرَّفة، و**أن كل تعبير regex فيه يطابق
   فعلًا ملفات هذا الريبو ويُخرج القيمة الصحيحة** (حُوكيت التعابير الأحد عشر
   جميعًا على الملفات الحقيقية). ما لم يُختبَر: تنفيذ PowerShell نفسه.
2. **‏`build-tools;34.0.0` اشتقاق لا اقتباس.** لو رفضه AGP، فالرسالة ستكون
   صريحة وقابلة للتصحيح بـ `-BuildToolsVersion`.
3. **رابط Temurin** يستعمل `api.adoptium.net/v3/binary/latest/17/ga/...` أي
   **أحدث إصدار من 17**، لا نسخة patch مثبَّتة. هذا مقصود (لا يوجد pin لها في
   الريبو) وهو مصدر تباين صغير محتمَل بين جهازين.
4. **‏`flutter doctor` قد يبقى أصفر** بسبب Visual Studio أو غياب جهاز موصول —
   ولا شيء من ذلك يمنع APK للأندرويد، ولهذا **لا يُستعمل كبوابة**، بل يُسجَّل
   ويُعرض فقط.
5. **قرار `applicationId`** (`com.aifamilycoach.parent_app` /
   `com.aifamilycoach.child_app`) ما زال معلّقًا ولا يتغيّر بعد أول نشر على
   Play. السكربت يطبعه وينذر منه — ولا يحسمه.
   انظر `docs/release/STORE_READINESS.md`.
