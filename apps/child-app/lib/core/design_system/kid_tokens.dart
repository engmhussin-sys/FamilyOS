import 'package:flutter/material.dart';

import '../theme/kid_theme.dart';

/// THE CHILD APP'S DESIGN TOKENS — audit PA-M-044.
///
/// `kid_theme.dart` is 98 lines of `ThemeData` with eight colour constants
/// and exactly two radii inlined as literals. It is a good palette with no
/// system around it. This file adds the system, sourcing every colour from
/// [KidTheme] rather than re-declaring it.
///
/// THE CHILD'S SCALE IS BIGGER THAN THE PARENT'S, ON PURPOSE. Touch targets
/// start at 56px (KidTheme already commits to that), spacing is roomier,
/// and radii are the toy-like 20px the theme already uses — a child reading
/// Arabic at arm's length on a cheap phone needs air, not density.
class KidColor {
  KidColor._();

  static const Color primary = KidTheme.skyBlue;
  static const Color success = KidTheme.leafGreen;
  static const Color highlight = KidTheme.sunshineYellow;
  static const Color magic = KidTheme.berryPurple;
  static const Color warm = KidTheme.coral;
  static const Color surface = Colors.white;
  static const Color background = KidTheme.cloudWhite;
  static const Color ink = KidTheme.softInk;
  static const Color mutedInk = KidTheme.mutedInk;

  /// SEMANTIC STATE COLOURS — and note what is NOT here: there is no
  /// `error red`. CONTEXT §3 principle 7 (NO PUNITIVE UX) means a child
  /// never sees a red failure chrome. A server "no" is [notNow] — warm,
  /// not alarming — and a genuine technical fault is [needsHelp], which is
  /// the same warm coral, because a child cannot act on the difference and
  /// should not be made to feel it.
  static const Color notNow = KidTheme.sunshineYellow;
  static const Color needsHelp = KidTheme.coral;
  static const Color done = KidTheme.leafGreen;
  static const Color waiting = KidTheme.berryPurple;

  static Color get hairline => KidTheme.softInk.withOpacity(0.08);
  static Color get border => KidTheme.softInk.withOpacity(0.12);
}

class KidSpace {
  KidSpace._();

  static const double xs = 6;
  static const double sm = 10;
  static const double md = 14;
  static const double lg = 20;
  static const double xl = 28;
  static const double xxl = 40;

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

class KidRadius {
  KidRadius._();

  static const double card = 20;
  static const double control = 18;
  static const double pill = 999;

  static BorderRadius get cardBorder => BorderRadius.circular(card);
  static BorderRadius get controlBorder => BorderRadius.circular(control);
}

class KidElevation {
  KidElevation._();

  static List<BoxShadow> get card => [
        BoxShadow(
          color: KidTheme.softInk.withOpacity(0.07),
          blurRadius: 16,
          offset: const Offset(0, 4),
        ),
      ];
}

class KidMotion {
  KidMotion._();

  static const Duration fast = Duration(milliseconds: 180);
  static const Duration normal = Duration(milliseconds: 320);
  static const Duration celebration = Duration(milliseconds: 1400);
}

class KidText {
  KidText._();

  static TextStyle screenTitle(BuildContext context) =>
      Theme.of(context).textTheme.headlineMedium ?? const TextStyle(fontSize: 24);

  static TextStyle sectionTitle(BuildContext context) =>
      Theme.of(context).textTheme.titleLarge ?? const TextStyle(fontSize: 20);

  static TextStyle cardTitle(BuildContext context) =>
      Theme.of(context).textTheme.titleMedium ?? const TextStyle(fontSize: 17);

  static TextStyle body(BuildContext context) =>
      Theme.of(context).textTheme.bodyLarge ?? const TextStyle(fontSize: 16);

  static TextStyle caption(BuildContext context) =>
      Theme.of(context).textTheme.bodyMedium ?? const TextStyle(fontSize: 14);

  /// The big number on a timer or a points card.
  static TextStyle display(BuildContext context) =>
      (Theme.of(context).textTheme.displaySmall ?? const TextStyle(fontSize: 32))
          .copyWith(fontWeight: FontWeight.w600);
}
