# Flutter CI — ما يشغّله العميل بالضبط، وماذا يقرأ بعده

| Document ID | Version | Owner Role | Status | Last Updated |
|---|---|---|---|---|
| REL-FLUTTER-CI-001 | 1.0 | Mobile Release Lead | `STATIC VERIFIED` — لم تُشغَّل | 2026-08-15 |

> **لم تُنفَّذ ولا تشغيلة CI واحدة في تاريخ هذا المشروع.** كل ما في هذا
> المستند وصف لما **سيحدث**، لا تقرير عمّا حدث. أول تشغيلة هي القياس الأول.

---

## 1. الأوامر — بهذا الترتيب

### 1.1 دفع الفرع (يفتح الحصار كله)

```bash
git push origin abny/sprint-f1-unblock
```

`.github/workflows/build-apk.yml` يعمل تلقائيًا على هذا الفرع. أو يدويًا:
**Actions ⇒ «Flutter — analyze, test, build APK» ⇒ Run workflow** (اختر
`both` / `parent-app` / `child-app`).

### 1.2 تثبيت التبعيات — الخطوة الوحيدة **الإلزامية** بعد التشغيلة الأولى

الـ CI يرفع، لكل تطبيق، artifact اسمه `pubspec-lock-<app>` يحوي ملف
`pubspec.lock` الذي حلّته تلك التشغيلة. **نزّله والتزمه:**

```bash
# من صفحة التشغيلة: Artifacts > pubspec-lock-parent-app / pubspec-lock-child-app
cp ~/Downloads/pubspec-lock-parent-app/pubspec.lock apps/parent-app/pubspec.lock
cp ~/Downloads/pubspec-lock-child-app/pubspec.lock  apps/child-app/pubspec.lock

git add apps/parent-app/pubspec.lock apps/child-app/pubspec.lock
git commit -m "chore(mobile): pin resolved dependency graph (PA-M-016)"
git push
```

**لماذا هذا إلزامي:** لا يوجد `pubspec.lock` في أيٍّ من التطبيقين، وكل قيد
تبعية هو `^caret`. أي أن **نفس الـ commit** قد يحلّ اليوم إلى شجرة تبعيات
وغدًا إلى أخرى — وplugin واحد يبدأ يطلب `compileSdk 35` يكسر AGP 8.1.1
**بحلول تاريخ، لا بتغيير**. توليد الملف يتطلّب `pub get`، الذي يتطلّب
`pub.dev`، وهو محجوب (403) في بيئة التأليف. **لهذا يولّده الـ CI ويلتزمه
العميل — دورة واحدة، لا أكثر.**

بعد الالتزام، يستخدم الـ workflow تلقائيًا:

```bash
flutter pub get --enforce-lockfile
```

فتصبح البناءات قابلة لإعادة الإنتاج، وأي انحراف يفشل بصوت عالٍ.

### 1.3 محليًا (لمن عنده Flutter SDK)

```bash
cd apps/parent-app      # ثم كرّرها في apps/child-app
flutter pub get
flutter analyze --no-fatal-infos
flutter test --reporter expanded
flutter build apk --debug --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1
```

بلا `--dart-define=API_BASE_URL` يُبنى APK **لا يستطيع مخاطبة أي backend**
(audit MA-004). المضيف يجب أن يكون واحدًا مما يسمح به
`android/app/src/debug/res/xml/network_security_config.xml`، أو `https`.

### 1.4 الفحوص الثابتة — تعمل بلا Flutter SDK إطلاقًا

```bash
python3 scripts/dart_preflight_selftest.py -v   # 12 ضابطًا سالبًا
python3 scripts/dart_preflight.py               # 12 فحصًا على التطبيقين
python3 scripts/verify_dart_imports.py
python3 scripts/verify_l10n_parity.py
python3 scripts/verify_network_security.py
python3 scripts/verify_gradle_syntax.py
```

هذه بالضبط ما تشغّله وظيفة `preflight` في الـ workflow، **قبل** تنزيل أي SDK.

---

## 2. ماذا يقرأ العميل بعد التشغيلة

التصميم **diagnostic-first**: كل مرحلة **تعمل** ويُلتقط ناتجها كاملًا، ثم
تفشل الوظيفة في النهاية على الحصيلة المجمّعة. الهدف: **دورة واحدة** تجيب عن
كل شيء، لا اثنتا عشرة دورة تجيب عن سطر واحد في كل مرة.

| أين | ماذا فيه |
|---|---|
| **Job Summary** | جدول `VERDICT` · عدّاد errors/warnings/infos · **تجميع بلاغات المحلّل حسب القاعدة** · جدول التبعيات المحلولة · حجم الـ APK · حالة Firebase |
| `analyze-<app>-<sha>` | ناتج `flutter analyze` كاملًا |
| `test-<app>-<sha>` | ناتج `flutter test --reporter expanded` كاملًا |
| `buildlog-<app>-<sha>` | سجل Gradle كاملًا (المفيد فيه عادة 200 سطر فوق سطر الفشل) |
| `<app>-debug-<sha>` | **الـ APK** |
| `pubspec-lock-<app>` | الملف الذي يجب التزامه (§1.2) |

**اقرأ «مجموعة حسب القاعدة» أولًا.** إن قالت `40 unused_import`، فهذا إصلاح
واحد مكرَّر أربعين مرة، لا أربعون مشكلة.

---

## 3. البوابات — ما الذي يُحمِّر التشغيلة

| البوابة | حاجزة؟ |
|---|---|
| `dart_preflight_selftest.py` (12 ضابطًا) | **نعم** |
| `dart_preflight.py` + الفحوص الثابتة الأربعة | **نعم** |
| `flutter pub get` | **نعم** |
| `flutter analyze --no-fatal-infos` | **نعم** — و`--fatal-warnings` هو الافتراضي وقد أُبقي |
| `flutter test` | **نعم** |
| `flutter build apk --debug` | **نعم** |
| `flutter build apk --release` | **لا** — bonus، ولا يُحاوَل بلا `RELEASE_API_BASE_URL` (ولا بلا Firebase لتطبيق الوالد) |

**لا `continue-on-error` عامّ · لا محلّل مُرخى · لا `// ignore:` جماعي · لا
اختبار محذوف.** `--no-fatal-infos` هو افتراضي الأداة نفسها، لا تخفيف تحته.

---

## 4. الإعدادات في المستودع

| الاسم | النوع | مطلوب؟ | الأثر |
|---|---|---|---|
| `GOOGLE_SERVICES_JSON` | Secret | **لا** | بوجوده يعمل push؛ بغيابه يُبنى APK بلا push (`docs/release/FIREBASE_SETUP.md`) |
| `DEV_API_BASE_URL` | Variable | لا | الافتراضي `http://10.0.2.2:3000/api/v1` |
| `RELEASE_API_BASE_URL` | Variable | لا | بغيابه يُتخطّى بناء الـ release عمدًا |

---

## 5. مصفوفة توافق التوليتشين

| المكوّن | القيمة | من أين | لماذا هي بالذات |
|---|---|---|---|
| Flutter | **3.24.5** | `env.FLUTTER_VERSION` | يشحن Dart 3.5.4 ⊂ `>=3.3.0 <4.0.0`؛ و3.27+ يرفع compileSdk إلى 35 فيكسر AGP 8.1.1 |
| Dart | 3.5.4 | تبعًا لـ Flutter | داخل قيد `pubspec.yaml` في التطبيقين |
| JDK | **17** | `env.JAVA_VERSION` | Gradle 8.3 لا يعمل على JDK 21 (‏«major version 65»)، وAGP 8.1.1 يريد 17، و`compileOptions` تعلن 17 |
| Gradle | **8.3** | `gradle-wrapper.properties` (التطبيقان) | — |
| AGP | **8.1.1** | `android/settings.gradle` | يرفض `compileSdk > 34` |
| Kotlin | **1.9.10** | `android/settings.gradle` | متوافق مع AGP 8.1.1 |
| `compileSdk` | **34** (حرفيًا) | `android/app/build.gradle` | كانت `flutter.compileSdkVersion` ⇒ تتبع تاريخًا لا commit |
| `targetSdk` | **34** (حرفيًا) | نفس الملف | يجعل `foregroundServiceType="specialUse"` ذا معنى |
| `minSdk` | **21** (حرفيًا) | نفس الملف | أرضية Flutter 3.24.5 نفسها، وأرضية `firebase-bom:33.1.2` |
| `ndkVersion` | `flutter.ndkVersion` | نفس الملف | **مُبقاة عمدًا** — لا يمكن التحقق من الرقم الحرفي بلا SDK، وتثبيت خاطئ يفشل كخطأ تنزيل غامض |
| Firebase BoM | 33.1.2 | `parent-app/.../build.gradle` | يثبّت الجانب الأصلي (native) |

---

## افتراضات ومخاطر مفتوحة

1. **لم يُشغَّل هذا الـ workflow قط.** كل ما فوقه قراءة ملفات وYAML صالح
   (‏`yaml.safe_load` على الملفين) وGroovy يُحلَّل نحويًا لملفات Gradle الستة.
   **لا شيء نُفِّذ.**
2. **`pubspec.lock` غير ملتزم بعد.** حتى تُنفَّذ §1.2، تشغيلتان متتاليتان قد
   تحلّان تبعيات مختلفة، وهذا **أكبر مصدر تباين متبقٍّ** في احتمال نجاح أول
   بناء.
3. **`analysis_options.yaml` غير موجود في أيٍّ من التطبيقين.** أي أن
   `flutter analyze` يعمل بقواعد Dart الأساسية فقط، رغم أن `lints: ^4.0.0`
   مُعلَنة كـ dev dependency. **لم يُضَف عمدًا:** إضافته الآن تعني إضافة عشرات
   بلاغات الأسلوب إلى تشغيلة أول قياس، وتخلط «الكود لا يُترجم» بـ «الكود لا
   يعجب الـ linter». يُضاف **بعد** أول ناتج أخضر، لا قبله.
4. **`--fatal-infos` غير مفعّل.** وهو افتراضي الأداة؛ رفعه قرار لاحق.
5. **Kotlin (21 ملفًا في تطبيق الطفل) لم يُترجَم قط.** الفحوص الثابتة هنا
   تغطّي Dart وGradle وXML، **لا الأنواع في Kotlin**. أول `assembleDebug` هو
   أول من سيراها.
