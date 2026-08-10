import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/observability/crash_reporting.dart';

void main() {
  bootstrapWithCrashReporting(() async {
    runApp(const ProviderScope(child: ChildAgentApp()));
  });
}
