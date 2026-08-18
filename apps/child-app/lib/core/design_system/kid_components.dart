import 'package:flutter/material.dart';

import 'kid_tokens.dart';

/// THE CHILD APP'S COMPONENT SET.
///
/// RTL: no `EdgeInsets.only(left:/right:)`, no `Alignment.centerLeft`
/// anywhere below — everything is `start`/`end` or symmetric.

class KidCard extends StatelessWidget {
  const KidCard({
    super.key,
    required this.child,
    this.onTap,
    this.padding = KidSpace.card,
    this.accent,
    this.dimmed = false,
  });

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsets padding;
  final Color? accent;

  /// A goal that is not available right now is DIMMED, never struck
  /// through and never marked with a lock. It is still there, it is still
  /// theirs, it is just not now.
  final bool dimmed;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: dimmed ? 0.62 : 1,
      child: Container(
        margin: const EdgeInsets.only(bottom: KidSpace.md),
        decoration: BoxDecoration(
          color: KidColor.surface,
          borderRadius: KidRadius.cardBorder,
          border: Border.all(color: accent?.withOpacity(0.35) ?? KidColor.hairline, width: accent == null ? 1 : 2),
          boxShadow: KidElevation.card,
        ),
        clipBehavior: Clip.antiAlias,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: onTap,
            child: Padding(padding: padding, child: child),
          ),
        ),
      ),
    );
  }
}

/// The big, unmissable action. 64px tall — bigger than the theme's 56px
/// floor, because on the goal screens this is the only thing to press.
class KidBigButton extends StatelessWidget {
  const KidBigButton({
    super.key,
    required this.label,
    this.onPressed,
    this.busy = false,
    this.icon,
    this.color,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool busy;
  final IconData? icon;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: KidSize.primaryButton,
      child: FilledButton(
        onPressed: busy ? null : onPressed,
        style: FilledButton.styleFrom(
          backgroundColor: color ?? KidColor.success,
          shape: RoundedRectangleBorder(borderRadius: KidRadius.controlBorder),
        ),
        child: busy
            ? const SizedBox(
                width: KidSize.spinnerSm,
                height: KidSize.spinnerSm,
                child: CircularProgressIndicator(strokeWidth: 2.5, color: KidColor.onColour),
              )
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (icon != null) ...[Icon(icon, size: KidSize.iconMd), KidSpace.hGapSm],
                  Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
                ],
              ),
      ),
    );
  }
}

class KidQuietButton extends StatelessWidget {
  const KidQuietButton({super.key, required this.label, this.onPressed, this.icon});

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: KidSize.touchTarget,
      child: OutlinedButton(
        onPressed: onPressed,
        style: OutlinedButton.styleFrom(
          foregroundColor: KidColor.ink,
          side: BorderSide(color: KidColor.border),
          shape: RoundedRectangleBorder(borderRadius: KidRadius.controlBorder),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[Icon(icon, size: KidSize.iconSm), KidSpace.hGapSm],
            Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
          ],
        ),
      ),
    );
  }
}

class KidBadge extends StatelessWidget {
  const KidBadge({super.key, required this.label, this.color, this.icon});

  final String label;
  final Color? color;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = color ?? KidColor.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: KidSpace.md, vertical: KidSpace.xs),
      decoration: BoxDecoration(
        color: c.withOpacity(0.16),
        borderRadius: BorderRadius.circular(KidRadius.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: KidSize.iconXs, color: c), const SizedBox(width: KidSpace.xs)],
          Text(label, style: KidText.badge(context).copyWith(color: c)),
        ],
      ),
    );
  }
}

/// A big headline number with a caption — points, level, streak days,
/// bonus minutes. Four screens needed this; it is defined once.
class KidStatTile extends StatelessWidget {
  const KidStatTile({
    super.key,
    required this.value,
    required this.label,
    this.icon,
    this.color,
  });

  final String value;
  final String label;
  final IconData? icon;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = color ?? KidColor.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: KidSpace.md, vertical: KidSpace.lg),
      decoration: BoxDecoration(
        color: c.withOpacity(0.10),
        borderRadius: KidRadius.cardBorder,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: KidSize.iconLg, color: c), KidSpace.gapXs],
          Text(
            value,
            style: KidText.display(context).copyWith(color: c),
            textAlign: TextAlign.center,
          ),
          KidSpace.gapXs,
          Text(
            label,
            style: KidText.caption(context),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

class KidSectionHeader extends StatelessWidget {
  const KidSectionHeader({super.key, required this.title, this.subtitle, this.trailing});

  final String title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: KidSpace.sm, top: KidSpace.sm),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: KidText.sectionTitle(context)),
                if (subtitle != null) ...[
                  KidSpace.gapXs,
                  Text(subtitle!, style: KidText.caption(context)),
                ],
              ],
            ),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

/// A GOAL LINE A CHILD CAN READ WITHOUT COUNTING: an icon, a label, a
/// bar, the two numbers, and — when it is done — a tick AND a colour, not
/// a colour alone.
///
/// `my_growth_screen` had this shape three times over, each time built
/// from an emoji, a hand-typed `LinearProgressIndicator` and a
/// `circular(8)`. It is one widget now.
///
/// NO EMOJI CARRIES THE MEANING: the "done" mark was `Text('✅')`,
/// which is a fact stated entirely in an emoji font — a font a cheap
/// Android device in Egypt may render as a grey outline, a tofu box, or
/// nothing at all. A Material glyph ships inside the app itself.
class KidProgressRow extends StatelessWidget {
  const KidProgressRow({
    super.key,
    required this.icon,
    required this.label,
    required this.valueLabel,
    required this.fraction,
    required this.achieved,
    required this.achievedSemanticLabel,
    this.color,
  });

  final IconData icon;
  final String label;

  /// Pre-formatted, e.g. "5 / 8" — the caller owns the units and digits.
  final String valueLabel;
  final double fraction;
  final bool achieved;

  /// Localised, e.g. «تم». Read aloud, not drawn: the tick is the visual,
  /// this is what a screen reader says instead of "check icon".
  final String achievedSemanticLabel;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = achieved ? KidColor.done : (color ?? KidColor.primary);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: KidSpace.sm),
      child: Row(
        children: [
          Icon(icon, size: KidSize.iconLg, color: c),
          KidSpace.hGapMd,
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: KidText.cardTitle(context)),
                KidSpace.gapXs,
                ClipRRect(
                  borderRadius: KidRadius.smBorder,
                  child: LinearProgressIndicator(
                    value: fraction.clamp(0.0, 1.0),
                    minHeight: KidSpace.sm,
                    backgroundColor: KidColor.hairline,
                    valueColor: AlwaysStoppedAnimation<Color>(c),
                  ),
                ),
              ],
            ),
          ),
          KidSpace.hGapMd,
          Text(valueLabel, style: KidText.stat(context)),
          if (achieved) ...[
            KidSpace.hGapSm,
            Semantics(
              label: achievedSemanticLabel,
              child: const Icon(
                Icons.check_circle_rounded,
                size: KidSize.iconSm,
                color: KidColor.done,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// ONE SOFT BLOCK THAT BREATHES — the brick of every loading skeleton.
/// Opacity pulse rather than a sliding shimmer: a shimmer repaints the
/// whole block every frame, and this app has to stay smooth on the
/// cheapest Android hardware sold in its market.
class KidSkeletonBlock extends StatefulWidget {
  const KidSkeletonBlock({super.key, this.width, this.height = 16, this.radius});

  final double? width;
  final double height;
  final double? radius;

  @override
  State<KidSkeletonBlock> createState() => _KidSkeletonBlockState();
}

class _KidSkeletonBlockState extends State<KidSkeletonBlock>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: KidMotion.pulse,
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween<double>(begin: 0.45, end: 1.0).animate(
        CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
      ),
      child: Container(
        width: widget.width,
        height: widget.height,
        decoration: BoxDecoration(
          color: KidColor.hairline,
          borderRadius: BorderRadius.circular(widget.radius ?? KidRadius.sm),
        ),
      ),
    );
  }
}

/// THE SHAPE OF THE PAGE BEFORE THE PAGE ARRIVES.
///
/// A child watching a spinner has no idea whether anything is coming.
/// Every list screen in this app draws the same thing — soft cards, one
/// per goal or reward — so the wait can show that instead of a circle.
///
/// Deliberately NOT a scroll view: this is dropped into `Scaffold.body`
/// and into `Column` branches, and a viewport handed unbounded height in
/// the second of those throws at runtime.
class KidSkeletonList extends StatelessWidget {
  const KidSkeletonList({super.key, this.rows = 3, this.padding = KidSpace.screen});

  final int rows;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    // Decoration only. What a screen reader announces is the loading
    // label beside it, not a stack of grey boxes.
    return ExcludeSemantics(
      child: Padding(
        padding: padding,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (int i = 0; i < rows; i++) ...[
              const _KidSkeletonCard(),
              KidSpace.gapMd,
            ],
          ],
        ),
      ),
    );
  }
}

class _KidSkeletonCard extends StatelessWidget {
  const _KidSkeletonCard();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: KidSpace.card,
      decoration: BoxDecoration(
        color: KidColor.surface,
        borderRadius: KidRadius.cardBorder,
        border: Border.all(color: KidColor.hairline),
      ),
      child: Row(
        children: [
          const KidSkeletonBlock(
            width: KidSize.touchTarget,
            height: KidSize.touchTarget,
            radius: KidRadius.control,
          ),
          KidSpace.hGapMd,
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: const [
                KidSkeletonBlock(height: 16),
                SizedBox(height: KidSpace.sm),
                KidSkeletonBlock(width: 120, height: 12),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The timer ring. Shows elapsed vs the program's required duration, and
/// deliberately does NOT decide anything: it is fed a fraction computed in
/// the application layer, and the SERVER measures the real elapsed time
/// from its own `startedAt`. This widget cannot make a child eligible.
class KidTimerRing extends StatelessWidget {
  const KidTimerRing({
    super.key,
    required this.progress,
    required this.centerLabel,
    required this.caption,
    this.color,
    this.size = 220,
  });

  final double progress;
  final String centerLabel;
  final String caption;
  final Color? color;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = color ?? KidColor.primary;
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          SizedBox(
            width: size,
            height: size,
            child: CircularProgressIndicator(
              value: progress.clamp(0.0, 1.0),
              strokeWidth: 14,
              backgroundColor: c.withOpacity(0.14),
              valueColor: AlwaysStoppedAnimation<Color>(c),
            ),
          ),
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(centerLabel, style: KidText.display(context).copyWith(color: c)),
              KidSpace.gapXs,
              Text(caption, style: KidText.caption(context), textAlign: TextAlign.center),
            ],
          ),
        ],
      ),
    );
  }
}
