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
}
