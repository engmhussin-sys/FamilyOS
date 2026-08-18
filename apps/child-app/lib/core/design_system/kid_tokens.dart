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

  /// `const`, not `withOpacity` getters, so a token can be used inside a
  /// `const` widget. A token that cannot appear where the value is needed
  /// gets replaced by a literal at the call site — the exact failure this
  /// file exists to prevent. Alpha is `(255 * opacity).round()` over
  /// [KidTheme.softInk] = 0xFF3A3654: 0.08 -> 20 (0x14), 0.12 -> 31 (0x1F).
  static const Color hairline = Color(0x143A3654);
  static const Color border = Color(0x1F3A3654);

  /// Text and icons drawn on a saturated panel or a coloured button.
  static const Color onColour = Colors.white;

  /// The "nothing is known yet" neutral. Screens were reaching for
  /// `Colors.grey`, which belongs to no palette in this product.
  static const Color unknown = KidTheme.mutedInk;
}

/// THE SPACING SCALE — 4pt, and the child's roominess does NOT come from
/// here.
///
/// AUDIT OF THIS PASS: the declared scale was 6 / 10 / 14 / 20 / 28 / 40,
/// but the screens were using 4, 8, 12, 16 and 24 — i.e. a 4pt scale — in
/// 60 of 88 places. So the token file and the app disagreed about what
/// "one step" meant, and every screen that had ever been written by hand
/// simply ignored the scale. Snapping 88 hand-typed numbers up onto an
/// unusual 6/10/14 rhythm would have moved layouts nobody in this
/// environment can look at; moving the three SMALL steps onto the 4pt
/// rhythm the app already used changes each affected gap by 2px and lands
/// every screen on the scale.
///
/// THE THREE LARGE STEPS ARE UNCHANGED (20 / 28 / 40), and that is
/// deliberate: `screen`, `card`, the empty-state rhythm and the section
/// gaps all read from those, so the child app's roominess — 20px card
/// padding, 20px radii, 56px minimum targets, a 64px primary button — is
/// untouched by this. Roominess lives in the card, the radius and the
/// target, not in the 2px between a number and its caption.
class KidSpace {
  KidSpace._();

  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
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

  /// For a thing drawn INSIDE a card — a progress-bar cap, a small
  /// swatch. Screens were typing `circular(3)` and `circular(8)`.
  static const double sm = 8;
  static const double control = 18;
  static const double card = 20;

  /// A hero / celebration panel. `circular(28)` was appearing on the two
  /// biggest surfaces in the app.
  static const double lg = 28;
  static const double pill = 999;

  static BorderRadius get smBorder => BorderRadius.circular(sm);
  static BorderRadius get cardBorder => BorderRadius.circular(card);
  static BorderRadius get controlBorder => BorderRadius.circular(control);
  static BorderRadius get lgBorder => BorderRadius.circular(lg);
}

/// ICON AND TARGET SIZES.
///
/// The child app's minimum target is 56, not the platform's 48, and
/// [KidTheme] already commits to that in its `filledButtonTheme`. It is a
/// token here so a screen can honour it without reading the theme.
class KidSize {
  KidSize._();

  static const double touchTarget = 56;
  static const double primaryButton = 64;

  static const double iconXs = 16;
  static const double iconSm = 20;
  static const double iconMd = 24;
  static const double iconLg = 28;
  static const double iconHero = 64;

  static const double spinnerSm = 22;
  static const double spinnerMd = 28;
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
  static const Duration pulse = Duration(milliseconds: 900);
}

/// THE DIAGONAL GRADIENT, AS A TOKEN AND AS AN RTL FIX.
///
/// Six cards in this app declared their own `LinearGradient` with
/// `begin: Alignment.topLeft, end: Alignment.bottomRight`. `Alignment` is
/// ABSOLUTE: it does not mirror under `Directionality.rtl`. So in Arabic
/// — the language this app opens in — every one of those cards was lit
/// from the corner opposite the one the text starts at, while the text
/// beside it had flipped. `AlignmentDirectional` resolves against the
/// ambient direction and the light comes from the reading-start corner in
/// both languages.
class KidGradient {
  KidGradient._();

  /// A softly tinted card that belongs to a domain.
  static LinearGradient tint(Color base) => LinearGradient(
        colors: [base.withOpacity(0.18), base.withOpacity(0.06)],
        begin: AlignmentDirectional.topStart,
        end: AlignmentDirectional.bottomEnd,
      );

  /// The warmer two-colour version used by the rewards summary.
  static LinearGradient duo(Color from, Color to) => LinearGradient(
        colors: [from.withOpacity(0.25), to.withOpacity(0.15)],
        begin: AlignmentDirectional.topStart,
        end: AlignmentDirectional.bottomEnd,
      );
}

/// DIRECTIONAL ICONS.
///
/// A child reading Arabic reads right-to-left, so "back" and "onward"
/// point the other way. The helpers pick the glyph from the ambient
/// direction AND pin the `Icon`'s own `textDirection` to `ltr`, which
/// switches off any second, automatic mirror the SDK might apply to a
/// glyph declared with `matchTextDirection` — getting that wrong flips
/// the arrow twice and lands back where it started.
class KidIcons {
  KidIcons._();

  static bool _isRtl(BuildContext context) =>
      Directionality.of(context) == TextDirection.rtl;

  static Widget back(BuildContext context, {Color? color, double? size}) {
    return Icon(
      _isRtl(context) ? Icons.arrow_forward_rounded : Icons.arrow_back_rounded,
      textDirection: TextDirection.ltr,
      color: color,
      size: size ?? KidSize.iconLg,
    );
  }

  static Widget disclosure(BuildContext context, {Color? color, double? size}) {
    return Icon(
      _isRtl(context) ? Icons.chevron_left_rounded : Icons.chevron_right_rounded,
      textDirection: TextDirection.ltr,
      color: color ?? KidColor.mutedInk,
      size: size ?? KidSize.iconMd,
    );
  }
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

  /// The pill / chip label. [KidBadge] was declaring this inline, which
  /// made it the one style in the component set a screen could not match
  /// without copying a literal.
  static TextStyle badge(BuildContext context) =>
      (Theme.of(context).textTheme.labelLarge ?? const TextStyle(fontSize: 13))
          .copyWith(fontSize: 13, fontWeight: FontWeight.w600, height: 1.4);

  /// A number the child is meant to read at a glance: 5/8 cups, 12 coins.
  /// Smaller than [display], heavier than [cardTitle].
  static TextStyle stat(BuildContext context) =>
      cardTitle(context).copyWith(fontWeight: FontWeight.w700);

  /// Text on a coloured button or a saturated panel.
  static TextStyle onColour(BuildContext context) =>
      body(context).copyWith(color: KidColor.onColour);
}
