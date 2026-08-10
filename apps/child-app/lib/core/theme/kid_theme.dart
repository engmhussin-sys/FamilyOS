import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// The Child App's design system — deliberately SEPARATE from any
/// theme the Parent App or Dashboard might use. A parent-facing admin
/// tool and a child-facing daily-use app have opposite design goals:
/// the parent tool optimizes for density and trust signals (the
/// existing dark "Guardian" palette elsewhere in this project); this
/// one optimizes for warmth, clarity at a glance, and forgiving large
/// touch targets for a young reader.
///
/// Design decisions, stated explicitly rather than left implicit:
/// - Typography: Fredoka — a rounded, friendly, highly legible
///   display font widely used in children's products. Never italic,
///   never a thin weight.
/// - Color: warm, saturated but NOT neon.
/// - Every interactive element has a minimum touch target of 56px.
/// - Corners are consistently very round (20px) — soft, toy-like.
class KidTheme {
  KidTheme._();

  static const Color sunshineYellow = Color(0xFFFFC93C);
  static const Color skyBlue = Color(0xFF4EA5F5);
  static const Color leafGreen = Color(0xFF5FD68A);
  static const Color berryPurple = Color(0xFF9B6BEC);
  static const Color coral = Color(0xFFFF7A6B);
  static const Color cloudWhite = Color(0xFFFFFDF8);
  static const Color softInk = Color(0xFF3A3654);
  static const Color mutedInk = Color(0xFF8A86A0);

  static const Color habitsAccent = leafGreen;
  static const Color healthAccent = skyBlue;
  static const Color faithAccent = berryPurple;
  static const Color messagesAccent = coral;
  static const Color celebrationAccent = sunshineYellow;

  static TextTheme _textTheme(TextTheme base) {
    return GoogleFonts.fredokaTextTheme(base).copyWith(
      displaySmall: GoogleFonts.fredoka(fontSize: 32, fontWeight: FontWeight.w600, color: softInk),
      headlineMedium: GoogleFonts.fredoka(fontSize: 24, fontWeight: FontWeight.w600, color: softInk),
      titleLarge: GoogleFonts.fredoka(fontSize: 20, fontWeight: FontWeight.w600, color: softInk),
      titleMedium: GoogleFonts.fredoka(fontSize: 17, fontWeight: FontWeight.w500, color: softInk),
      bodyLarge: GoogleFonts.fredoka(fontSize: 16, fontWeight: FontWeight.w400, color: softInk),
      bodyMedium: GoogleFonts.fredoka(fontSize: 14, fontWeight: FontWeight.w400, color: mutedInk),
      labelLarge: GoogleFonts.fredoka(fontSize: 16, fontWeight: FontWeight.w600),
    );
  }

  static ThemeData get theme {
    final base = ThemeData(useMaterial3: true, brightness: Brightness.light);
    return base.copyWith(
      scaffoldBackgroundColor: cloudWhite,
      colorScheme: base.colorScheme.copyWith(
        primary: skyBlue,
        secondary: sunshineYellow,
        surface: cloudWhite,
        error: coral,
      ),
      textTheme: _textTheme(base.textTheme),
      appBarTheme: AppBarTheme(
        backgroundColor: cloudWhite,
        foregroundColor: softInk,
        elevation: 0,
        centerTitle: true,
        titleTextStyle: GoogleFonts.fredoka(fontSize: 22, fontWeight: FontWeight.w600, color: softInk),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: Colors.white,
        margin: const EdgeInsets.only(bottom: 12),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: leafGreen,
          foregroundColor: Colors.white,
          minimumSize: const Size(56, 56),
          padding: const EdgeInsets.symmetric(horizontal: 24),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
          textStyle: GoogleFonts.fredoka(fontSize: 17, fontWeight: FontWeight.w600),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: skyBlue,
        foregroundColor: Colors.white,
        extendedTextStyle: GoogleFonts.fredoka(fontSize: 16, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      ),
      chipTheme: base.chipTheme.copyWith(
        backgroundColor: sunshineYellow.withOpacity(0.25),
        labelStyle: GoogleFonts.fredoka(fontSize: 13, fontWeight: FontWeight.w500, color: softInk),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        shape: const StadiumBorder(),
      ),
      iconTheme: const IconThemeData(color: skyBlue, size: 28),
    );
  }
}
