package com.aifamilycoach.parent_app

// RECOVERY NOTE (Sprint 17.3): standard Flutter template
// MainActivity — Parent App has no native platform-channel
// integration (confirmed: zero MethodChannel usage found anywhere in
// apps/parent-app/lib during this Sprint's own audit), unlike Child
// App's real native agent layer. A plain FlutterActivity is the
// correct, honest scaffold here, not an invented integration.
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
