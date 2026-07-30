import 'package:flutter/material.dart';

/// Mirrors the Admin Dashboard's "Quiet Guardian" palette so the Parent
/// App and the web Dashboard feel like the same product, not two skins.
class AppTheme {
  static const guardian950 = Color(0xFF14213D);
  static const sand50 = Color(0xFFFAF7F2);
  static const sage500 = Color(0xFF6B8F71);
  static const amber500 = Color(0xFFE0A458);
  static const brick500 = Color(0xFFC1502E);

  static ThemeData light() {
    return ThemeData(
      useMaterial3: true,
      scaffoldBackgroundColor: sand50,
      colorScheme: ColorScheme.fromSeed(
        seedColor: guardian950,
        primary: guardian950,
        secondary: sage500,
        error: brick500,
        brightness: Brightness.light,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: sand50,
        foregroundColor: guardian950,
        elevation: 0,
      ),
    );
  }

  /// PRODUCTION READINESS REVIEW FINDING (UI/UX Review — Dark Mode
  /// Readiness): no dark variant existed at all. `ThemeMode.system`
  /// (set in `main.dart`) would have silently fallen back to Flutter's
  /// own default Material theme on a device set to dark mode, clashing
  /// visibly with the light-mode-only screens around it.
  static ThemeData dark() {
    return ThemeData(
      useMaterial3: true,
      scaffoldBackgroundColor: const Color(0xFF0F1729),
      colorScheme: ColorScheme.fromSeed(
        seedColor: guardian950,
        primary: sage500,
        secondary: amber500,
        error: brick500,
        brightness: Brightness.dark,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: Color(0xFF0F1729),
        foregroundColor: sand50,
        elevation: 0,
      ),
    );
  }
}
