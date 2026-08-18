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

  /// THE FOUR HUES THAT WERE BEING RE-TYPED AS RAW HEX. Audit of this
  /// pass: `Color(0xFF6B5B95)` appeared in four screens, `0xFF3D8FB4` in
  /// two, and `0xFF3D6FB4` / `0xFF3D8FB4` were being used for the SAME
  /// concept (learning) in two different screens — a literal one-digit
  /// divergence that no reviewer would ever catch by eye. They live here
  /// once; screens ask for the semantic name below, never the hue.
  static const Color plum = Color(0xFF6B5B95);
  static const Color ocean = Color(0xFF3D8FB4);
  static const Color indigo = Color(0xFF3D6FB4);
  static const Color clay = Color(0xFFB4653D);

  /// DOMAIN ACCENTS — the colour a life-area is drawn in, named after the
  /// area and not after the hue, so "what colour is Faith?" has exactly
  /// one answer across the timeline, the faith screen and any future one.
  static const Color domainHealth = danger;
  static const Color domainLearning = indigo;
  static const Color domainFaith = plum;
  static const Color domainSleep = plum;
  static const Color domainTime = ocean;
  static const Color domainHydration = ocean;
  static const Color domainRewards = warn;
  static const Color domainSafety = ink;
  static const Color domainHabits = accent;
  static const Color domainFamily = clay;

  /// Text and icons drawn ON a saturated/dark panel. `Colors.white70` and
  /// `Colors.white54` were being typed inline; both are now named, and
  /// the muted one is deliberately lighter than Material's 70% because
  /// Arabic strokes are thinner than Latin at the same optical size.
  static const Color onDark = Colors.white;
  static Color get onDarkMuted => Colors.white.withOpacity(0.78);
  static Color get onDarkFaint => Colors.white.withOpacity(0.60);
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

  /// For things drawn INSIDE a card: progress-bar caps, tiny status
  /// blocks, inline swatches. Replaces hand-typed `circular(2)`,
  /// `circular(4)` and `circular(8)`.
  static const double sm = 8;
  static const double control = 12;
  static const double card = 14;

  /// The feature/hero panel radius. Screens were typing `circular(16)`,
  /// `circular(18)`, `circular(20)` and `circular(22)` for the same
  /// visual role; there is now one answer.
  static const double lg = 20;
  static const double pill = 999;

  static BorderRadius get smBorder => BorderRadius.circular(sm);
  static BorderRadius get cardBorder => BorderRadius.circular(card);
  static BorderRadius get controlBorder => BorderRadius.circular(control);
  static BorderRadius get lgBorder => BorderRadius.circular(lg);
}

/// Icon sizes as tokens. Seven distinct literals (13, 16, 18, 20, 26, 32,
/// 44) were in use for five actual roles.
class DsIconSize {
  DsIconSize._();

  static const double xs = 14;
  static const double sm = 18;
  static const double md = 20;
  static const double lg = 24;
  static const double hero = 44;
}

/// Minimum interactive sizes. The parent app's floor is 48 (Material's
/// accessibility minimum); the child app's is deliberately higher and
/// lives in its own token file.
class DsSize {
  DsSize._();

  static const double touchTarget = 48;
  static const double spinnerSm = 18;
  static const double spinnerMd = 24;
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
  static const Duration pulse = Duration(milliseconds: 900);
}

/// THE DIAGONAL GRADIENT, AND WHY IT IS A TOKEN.
///
/// Seven screens declared their own `LinearGradient` with
/// `begin: Alignment.topLeft, end: Alignment.bottomRight`. `Alignment` is
/// ABSOLUTE — it does not mirror under `Directionality.rtl` — so in
/// Arabic, which is this product's default, every one of those panels lit
/// from the same physical corner the Latin layout lit from, while all the
/// content beside it had flipped. `AlignmentDirectional.topStart` /
/// `bottomEnd` resolve against the ambient direction, so the light comes
/// from the reading-start corner in both languages.
class DsGradient {
  DsGradient._();

  /// A saturated hero panel: a solid brand colour, slightly graded.
  static LinearGradient hero(Color base) => LinearGradient(
        colors: [base.withOpacity(0.85), base.withOpacity(0.60)],
        begin: AlignmentDirectional.topStart,
        end: AlignmentDirectional.bottomEnd,
      );

  /// A faint tinted surface — a card that belongs to a domain without
  /// shouting about it.
  static LinearGradient tint(Color base) => LinearGradient(
        colors: [base.withOpacity(0.16), base.withOpacity(0.06)],
        begin: AlignmentDirectional.topStart,
        end: AlignmentDirectional.bottomEnd,
      );
}

/// DIRECTIONAL ICONS.
///
/// A "back" chevron must point toward the start of the line, which in
/// Arabic is the right. Flutter can do this automatically for icons
/// declared with `matchTextDirection`, but which glyphs carry that flag
/// is an SDK detail, and getting it wrong flips the arrow TWICE. So both
/// helpers below choose the glyph explicitly AND pin `textDirection` to
/// `ltr` on the `Icon`, which disables any second, automatic mirror. The
/// result is correct whether or not the SDK would have mirrored it.
class DsIcons {
  DsIcons._();

  static bool _isRtl(BuildContext context) =>
      Directionality.of(context) == TextDirection.rtl;

  /// The "go back" affordance.
  static Widget back(BuildContext context, {Color? color, double? size}) {
    return Icon(
      _isRtl(context) ? Icons.arrow_forward_rounded : Icons.arrow_back_rounded,
      textDirection: TextDirection.ltr,
      color: color,
      size: size ?? DsIconSize.lg,
    );
  }

  /// The "this row opens something" chevron at the end of a list tile.
  static Widget disclosure(BuildContext context, {Color? color, double? size}) {
    return Icon(
      _isRtl(context) ? Icons.chevron_left_rounded : Icons.chevron_right_rounded,
      textDirection: TextDirection.ltr,
      color: color ?? DsColor.stateMuted,
      size: size ?? DsIconSize.lg,
    );
  }
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

  /// The small all-caps-weight label above a number in a hero panel.
  static TextStyle label(BuildContext context) =>
      Theme.of(context).textTheme.labelLarge ?? const TextStyle(fontSize: 14);

  /// The big number itself.
  static TextStyle display(BuildContext context) =>
      (Theme.of(context).textTheme.displaySmall ?? const TextStyle(fontSize: 30))
          .copyWith(fontWeight: FontWeight.w700);

  /// The 12pt semibold pill text. [DsBadge] was declaring this inline,
  /// which made it the one text style in the component set that no screen
  /// could match without copying a literal.
  static TextStyle badge(BuildContext context) =>
      (Theme.of(context).textTheme.labelLarge ?? const TextStyle(fontSize: 12))
          .copyWith(fontSize: 12, fontWeight: FontWeight.w600, height: 1.3);

  /// Body/caption drawn on a dark or saturated panel.
  static TextStyle onDarkLabel(BuildContext context) =>
      label(context).copyWith(color: DsColor.onDarkMuted);

  static TextStyle onDarkBody(BuildContext context) =>
      body(context).copyWith(color: DsColor.onDarkMuted);

  static TextStyle onDarkDisplay(BuildContext context) =>
      display(context).copyWith(color: DsColor.onDark);
}
