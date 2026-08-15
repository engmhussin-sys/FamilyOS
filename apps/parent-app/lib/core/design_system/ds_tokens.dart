import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// THE DESIGN TOKENS — audit PA-M-044 / PA-M-046.
///
/// The finding, verbatim: "لا يوجد Design System. يوجد `ThemeData` واحد
/// لكل تطبيق … بلا spacing scale، بلا elevation tokens، بلا مكوّنات
/// مسمّاة، وبلا حالات موحّدة" — and 12 inline styling sites on the
/// dashboard alone, 11 more screens with ≥6 each.
///
/// SCOPE, STATED HONESTLY: this file does NOT restyle the existing 26
/// screens. It establishes the system and the B6/B7 surface uses it for
/// everything. Migrating the older screens is a separate, mechanical
/// change that should happen once a real `flutter analyze` can prove it
/// broke nothing.
///
/// COLOR SOURCE: [AppTheme]'s existing five constants, re-exported here
/// rather than re-declared. A second palette next to the first would be
/// the exact duplication CONTEXT §3 principle 1 forbids; this is a naming
/// layer over one source of truth, not a copy of it.
class DsColor {
  DsColor._();

  static const Color ink = AppTheme.guardian950;
  static const Color surfaceAlt = AppTheme.sand50;
  static const Color accent = AppTheme.sage500;
  static const Color warn = AppTheme.amber500;
  static const Color danger = AppTheme.brick500;
  static const Color surface = Colors.white;

  /// Semantic aliases for the four states, so no screen ever picks a raw
  /// colour for "this failed" again.
  static const Color stateError = danger;
  static const Color stateSuccess = accent;
  static const Color statePending = warn;
  static Color get stateMuted => ink.withOpacity(0.45);

  /// Hairlines, fills and dividers — the three opacities that were being
  /// hand-typed as `withOpacity(0.08)` / `(0.12)` / `(0.25)` across the app.
  static Color get hairline => ink.withOpacity(0.08);
  static Color get border => ink.withOpacity(0.12);
  static Color get borderStrong => ink.withOpacity(0.25);
}

/// A 4pt spacing scale. Every gap in the B6/B7 surface is one of these six
/// values — no free-typed `SizedBox(height: 13)`.
class DsSpace {
  DsSpace._();

  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;

  static const EdgeInsets screen = EdgeInsets.all(lg);
  static const EdgeInsets card = EdgeInsets.all(lg);

  static const SizedBox gapXs = SizedBox(height: xs);
  static const SizedBox gapSm = SizedBox(height: sm);
  static const SizedBox gapMd = SizedBox(height: md);
  static const SizedBox gapLg = SizedBox(height: lg);
  static const SizedBox gapXl = SizedBox(height: xl);

  static const SizedBox hGapSm = SizedBox(width: sm);
  static const SizedBox hGapMd = SizedBox(width: md);
}

/// The two radii the existing theme already uses (`_cardRadius = 14`,
/// `_buttonRadius = 12`), promoted from private constants to tokens plus
/// the pill radius the chips already imply.
class DsRadius {
  DsRadius._();

  static const double card = 14;
  static const double control = 12;
  static const double pill = 999;

  static BorderRadius get cardBorder => BorderRadius.circular(card);
  static BorderRadius get controlBorder => BorderRadius.circular(control);
}

/// Elevation as a token, not a magic number. The Parent App's visual
/// language is flat-with-a-hairline, not Material shadow.
class DsElevation {
  DsElevation._();

  static List<BoxShadow> get card => [
        BoxShadow(
          color: DsColor.ink.withOpacity(0.05),
          blurRadius: 12,
          offset: const Offset(0, 3),
        ),
      ];
}

/// One animation duration for the whole new surface.
class DsMotion {
  DsMotion._();

  static const Duration fast = Duration(milliseconds: 150);
  static const Duration normal = Duration(milliseconds: 260);
}

/// Named text roles, resolved from the ThemeData the app already builds.
/// A screen asks for `DsText.sectionTitle(context)`, never for
/// `TextStyle(fontSize: 18, fontWeight: FontWeight.w600)`.
class DsText {
  DsText._();

  static TextStyle screenTitle(BuildContext context) =>
      Theme.of(context).textTheme.headlineMedium ?? const TextStyle(fontSize: 22);

  static TextStyle sectionTitle(BuildContext context) =>
      Theme.of(context).textTheme.titleLarge ?? const TextStyle(fontSize: 18);

  static TextStyle cardTitle(BuildContext context) =>
      Theme.of(context).textTheme.titleMedium ?? const TextStyle(fontSize: 15);

  static TextStyle body(BuildContext context) =>
      Theme.of(context).textTheme.bodyLarge ?? const TextStyle(fontSize: 15);

  static TextStyle caption(BuildContext context) =>
      (Theme.of(context).textTheme.bodyMedium ?? const TextStyle(fontSize: 13))
          .copyWith(color: DsColor.stateMuted);
}
