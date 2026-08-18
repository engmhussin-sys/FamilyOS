import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Mirrors the Admin Dashboard's "Quiet Guardian" palette so the Parent
/// App and the web Dashboard feel like the same product, not two skins.
///
/// DESIGN PASS 2: the color palette below was already sound (a real,
/// deliberate "trustworthy guardian" choice — deep navy, warm sand,
/// calm sage) — this pass elevates everything AROUND that palette
/// toward a modern, premium feel: real typography (Inter, replacing
/// the Material default), a consistent rounded-but-not-playful
/// shape language (14px — softer than sharp corporate corners,
/// noticeably more restrained than the Child App's 20px), and real
/// elevation/shadow treatment on cards instead of Material's flat
/// default. A parent-facing tool earns trust through polish and
/// restraint, not through the same bright playfulness the Child App
/// deliberately uses — the two apps should never look like the same
/// design system wearing different colors.
class AppTheme {
  static const guardian950 = Color(0xFF14213D);
  static const sand50 = Color(0xFFFAF7F2);
  static const sage500 = Color(0xFF6B8F71);
  static const amber500 = Color(0xFFE0A458);
  static const brick500 = Color(0xFFC1502E);

  static const double _cardRadius = 14;
  static const double _buttonRadius = 12;

  /// ONE TYPE SCALE, WITH ARABIC LINE HEIGHTS.
  ///
  /// Every role below now declares an explicit `height`. Before this pass
  /// only the two body roles did, which meant the four heading roles fell
  /// back to the font's own default line box — computed for Latin. Arabic
  /// needs more: it stacks marks ABOVE the baseline (fatha, shadda, the
  /// dots of ث/ش) and drops descenders well BELOW it (ج ح خ ع غ م ه ي),
  /// so a line box tuned for "x-height plus a little" clips a heading the
  /// moment a real Arabic word lands in it. The values rise as the size
  /// falls, because the proportional cost of a mark is worse at 13pt than
  /// at 30pt.
  ///
  /// `letterSpacing` IS GONE, DELIBERATELY. It was -0.5 / -0.3 on the two
  /// display roles and +0.1 on labels — all three tuned for Inter's Latin
  /// forms. Arabic is a JOINED script: tracking is inserted between
  /// glyphs after shaping, so it pulls apart or crushes together letters
  /// that are supposed to be connected, and this product's default
  /// language is Arabic. A theme cannot vary tracking per script, so the
  /// one setting that is correct in both is none. Latin headings read
  /// very slightly looser than before; Arabic headings stop being
  /// deformed.
  static TextTheme _textTheme(TextTheme base, Color displayColor, Color bodyColor) {
    return GoogleFonts.interTextTheme(base).copyWith(
      displaySmall: GoogleFonts.inter(fontSize: 30, fontWeight: FontWeight.w700, color: displayColor, height: 1.25),
      headlineMedium: GoogleFonts.inter(fontSize: 22, fontWeight: FontWeight.w700, color: displayColor, height: 1.32),
      titleLarge: GoogleFonts.inter(fontSize: 18, fontWeight: FontWeight.w600, color: displayColor, height: 1.38),
      titleMedium: GoogleFonts.inter(fontSize: 15, fontWeight: FontWeight.w600, color: displayColor, height: 1.42),
      bodyLarge: GoogleFonts.inter(fontSize: 15, fontWeight: FontWeight.w400, color: bodyColor, height: 1.6),
      bodyMedium: GoogleFonts.inter(fontSize: 13, fontWeight: FontWeight.w400, color: bodyColor, height: 1.55),
      labelLarge: GoogleFonts.inter(fontSize: 14, fontWeight: FontWeight.w600, height: 1.3),
    );
  }

  static ThemeData light() {
    final base = ThemeData(
      useMaterial3: true,
      scaffoldBackgroundColor: sand50,
      colorScheme: ColorScheme.fromSeed(
        seedColor: guardian950,
        primary: guardian950,
        secondary: sage500,
        error: brick500,
        brightness: Brightness.light,
      ),
    );
    return base.copyWith(
      textTheme: _textTheme(base.textTheme, guardian950, const Color(0xFF5B5F6B)),
      appBarTheme: const AppBarTheme(
        backgroundColor: sand50,
        foregroundColor: guardian950,
        elevation: 0,
        centerTitle: false,
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: Colors.white,
        shadowColor: guardian950.withOpacity(0.08),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(_cardRadius)),
        margin: const EdgeInsets.only(bottom: 12),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: guardian950,
          minimumSize: const Size(0, 48),
          padding: const EdgeInsets.symmetric(horizontal: 20),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(_buttonRadius)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 48),
          side: BorderSide(color: guardian950.withOpacity(0.25)),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(_buttonRadius)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_buttonRadius),
          borderSide: BorderSide(color: guardian950.withOpacity(0.12)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_buttonRadius),
          borderSide: BorderSide(color: guardian950.withOpacity(0.12)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_buttonRadius),
          borderSide: const BorderSide(color: guardian950, width: 1.5),
        ),
      ),
      chipTheme: base.chipTheme.copyWith(
        backgroundColor: sage500.withOpacity(0.12),
        labelStyle: GoogleFonts.inter(fontSize: 12, fontWeight: FontWeight.w600, color: guardian950),
        shape: const StadiumBorder(),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      ),
      dividerTheme: DividerThemeData(color: guardian950.withOpacity(0.08), thickness: 1),
    );
  }

  /// PRODUCTION READINESS REVIEW FINDING (UI/UX Review — Dark Mode
  /// Readiness): no dark variant existed at all. `ThemeMode.system`
  /// (set in `main.dart`) would have silently fallen back to Flutter's
  /// own default Material theme on a device set to dark mode, clashing
  /// visibly with the light-mode-only screens around it.
  static ThemeData dark() {
    const darkBg = Color(0xFF0F1729);
    final base = ThemeData(
      useMaterial3: true,
      scaffoldBackgroundColor: darkBg,
      colorScheme: ColorScheme.fromSeed(
        seedColor: guardian950,
        primary: sage500,
        secondary: amber500,
        error: brick500,
        brightness: Brightness.dark,
      ),
    );
    return base.copyWith(
      textTheme: _textTheme(base.textTheme, sand50, const Color(0xFFB7BAC4)),
      appBarTheme: const AppBarTheme(
        backgroundColor: darkBg,
        foregroundColor: sand50,
        elevation: 0,
        centerTitle: false,
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: const Color(0xFF19233E),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(_cardRadius)),
        margin: const EdgeInsets.only(bottom: 12),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: sage500,
          minimumSize: const Size(0, 48),
          padding: const EdgeInsets.symmetric(horizontal: 20),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(_buttonRadius)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0xFF19233E),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_buttonRadius),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_buttonRadius),
          borderSide: const BorderSide(color: sage500, width: 1.5),
        ),
      ),
    );
  }
}
