import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/config/app_config.dart';
import 'core/observability/crash_reporting.dart';

void main() {
  // F2 (audit MA-004). Deliberately the FIRST statement, before the Sentry
  // zone is installed: a misconfigured base URL must surface as a plain,
  // attributable startup failure on the console, not as a captured event in
  // a project nobody is watching yet. Debug builds only warn; release builds
  // throw, because a release APK pointed at http://10.0.2.2 cannot work and
  // must not pretend otherwise.
  AppConfig.assertUsableForBuildMode();
  bootstrapWithCrashReporting(() async {
    runApp(const ProviderScope(child: ChildAgentApp()));
  });
}
