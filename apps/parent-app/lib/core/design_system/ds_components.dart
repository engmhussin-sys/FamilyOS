import 'package:flutter/material.dart';

import 'ds_tokens.dart';

/// THE COMPONENT SET — eight named widgets, per audit PA-M-044's own
/// prescription ("حزمة design_system مشتركة: tokens + 8 مكوّنات + 4
/// حالات، قبل رسم شاشات F4 الـ14").
///
/// RTL: not one component below uses `EdgeInsets.only(left:/right:)` or
/// `Alignment.centerLeft`. Everything is `start`/`end` or symmetric, so
/// the same widget is correct in both directions without a single
/// `Directionality` check — which is the only way "RTL حقيقي، لا ترجمة"
/// (CONTEXT §1) survives contact with a hundred new widgets.

/// A content card. Replaces the hand-rolled `Container(decoration:
/// BoxDecoration(...))` that appears in a dozen existing screens.
class DsCard extends StatelessWidget {
  const DsCard({
    super.key,
    required this.child,
    this.onTap,
    this.padding = DsSpace.card,
    this.accent,
  });

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsets padding;

  /// A 4px leading rail in a semantic colour — how status is expressed on
  /// a card without a coloured background (which harms contrast in RTL
  /// Arabic text far more than in Latin).
  final Color? accent;

  @override
  Widget build(BuildContext context) {
    final content = Padding(padding: padding, child: child);
    return Container(
      margin: const EdgeInsets.only(bottom: DsSpace.md),
      decoration: BoxDecoration(
        color: DsColor.surface,
        borderRadius: DsRadius.cardBorder,
        border: Border.all(color: DsColor.hairline),
        boxShadow: DsElevation.card,
      ),
      clipBehavior: Clip.antiAlias,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          child: accent == null
              ? content
              : Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Container(width: 4, color: accent),
                    Expanded(child: content),
                  ],
                ),
        ),
      ),
    );
  }
}

/// A section heading with an optional trailing action.
class DsSectionHeader extends StatelessWidget {
  const DsSectionHeader({super.key, required this.title, this.subtitle, this.trailing});

  final String title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: DsSpace.sm, top: DsSpace.sm),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: DsText.sectionTitle(context)),
                if (subtitle != null) ...[
                  DsSpace.gapXs,
                  Text(subtitle!, style: DsText.caption(context)),
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

/// The primary action. Full width by default because every new screen's
/// primary action in this flow is a full-width commit.
class DsPrimaryButton extends StatelessWidget {
  const DsPrimaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.busy = false,
    this.icon,
    this.expand = true,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool busy;
  final IconData? icon;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final button = FilledButton(
      onPressed: busy ? null : onPressed,
      child: busy
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
            )
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon != null) ...[Icon(icon, size: 18), DsSpace.hGapSm],
                Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
              ],
            ),
    );
    return expand ? SizedBox(width: double.infinity, child: button) : button;
  }
}

/// The secondary action.
class DsSecondaryButton extends StatelessWidget {
  const DsSecondaryButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.danger = false,
    this.expand = true,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool danger;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final color = danger ? DsColor.danger : DsColor.ink;
    final button = OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        foregroundColor: color,
        side: BorderSide(color: color.withOpacity(0.3)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: 18), DsSpace.hGapSm],
          Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
        ],
      ),
    );
    return expand ? SizedBox(width: double.infinity, child: button) : button;
  }
}

/// A selectable option row — the workhorse of the create wizard's first
/// five steps (category, activity, verification method, reward type,
/// difficulty). Radio semantics, a 56px minimum target, and a rationale
/// line, because F4 ships a `rationaleAr` for every verification method
/// and hiding it would make the parent guess.
class DsChoiceTile extends StatelessWidget {
  const DsChoiceTile({
    super.key,
    required this.title,
    required this.selected,
    required this.onTap,
    this.subtitle,
    this.badge,
    this.enabled = true,
  });

  final String title;
  final String? subtitle;
  final String? badge;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final borderColor = selected ? DsColor.accent : DsColor.border;
    return Opacity(
      opacity: enabled ? 1 : 0.45,
      child: Container(
        margin: const EdgeInsets.only(bottom: DsSpace.sm),
        decoration: BoxDecoration(
          color: selected ? DsColor.accent.withOpacity(0.08) : DsColor.surface,
          borderRadius: DsRadius.controlBorder,
          border: Border.all(color: borderColor, width: selected ? 1.5 : 1),
        ),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: enabled ? onTap : null,
            borderRadius: DsRadius.controlBorder,
            child: Container(
              constraints: const BoxConstraints(minHeight: 56),
              padding: const EdgeInsets.symmetric(
                horizontal: DsSpace.lg,
                vertical: DsSpace.md,
              ),
              child: Row(
                children: [
                  Icon(
                    selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                    size: DsIconSize.md,
                    color: selected ? DsColor.accent : DsColor.stateMuted,
                  ),
                  DsSpace.hGapMd,
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(title, style: DsText.cardTitle(context)),
                        if (subtitle != null) ...[
                          DsSpace.gapXs,
                          Text(subtitle!, style: DsText.caption(context)),
                        ],
                      ],
                    ),
                  ),
                  if (badge != null) ...[DsSpace.hGapSm, DsBadge(label: badge!)],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A small pill. One place decides what a pill looks like.
class DsBadge extends StatelessWidget {
  const DsBadge({super.key, required this.label, this.color, this.icon});

  final String label;
  final Color? color;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = color ?? DsColor.ink;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: DsSpace.md, vertical: DsSpace.xs),
      decoration: BoxDecoration(
        color: c.withOpacity(0.10),
        borderRadius: BorderRadius.circular(DsRadius.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: DsIconSize.xs, color: c), const SizedBox(width: DsSpace.xs)],
          Text(label, style: DsText.badge(context).copyWith(color: c)),
        ],
      ),
    );
  }
}

/// A label/value row. `digital_twin_screen.dart` and
/// `health_trend_screen.dart` each define their own private `_MetricRow`
/// with the same job — audit PA-M-044 measured that duplication. This is
/// the one both should eventually use.
class DsKeyValueRow extends StatelessWidget {
  const DsKeyValueRow({super.key, required this.label, required this.value, this.valueColor});

  final String label;
  final String value;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: DsSpace.xs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(flex: 2, child: Text(label, style: DsText.caption(context))),
          DsSpace.hGapSm,
          Expanded(
            flex: 3,
            child: Text(
              value,
              style: DsText.cardTitle(context).copyWith(color: valueColor),
            ),
          ),
        ],
      ),
    );
  }
}

/// A stepper header for the create wizard: "الخطوة ٣ من ٨" plus a real
/// progress bar. The wizard has eight steps and a parent who cannot see
/// where they are will abandon it.
class DsStepHeader extends StatelessWidget {
  const DsStepHeader({
    super.key,
    required this.label,
    required this.step,
    required this.totalSteps,
    this.hint,
  });

  final String label;
  final String? hint;
  final int step;
  final int totalSteps;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(DsRadius.pill),
          child: LinearProgressIndicator(
            value: totalSteps == 0 ? 0 : step / totalSteps,
            minHeight: 6,
            backgroundColor: DsColor.hairline,
            valueColor: const AlwaysStoppedAnimation<Color>(DsColor.accent),
          ),
        ),
        DsSpace.gapMd,
        Text(label, style: DsText.screenTitle(context)),
        if (hint != null) ...[
          DsSpace.gapXs,
          Text(hint!, style: DsText.caption(context)),
        ],
      ],
    );
  }
}

/// THE HEADLINE PANEL — one saturated block, one label, one number.
///
/// Five screens (`learning_progress`, `health_trend`, `digital_twin`,
/// `dashboard_home`, `add_child`) each hand-built this: the same
/// `Container` + `LinearGradient(topLeft → bottomRight)` + `labelLarge`
/// in `Colors.white70` + `displaySmall` in white, with four different
/// corner radii between them. It is one component now, its gradient is
/// direction-aware (see [DsGradient]), and its caption never disappears
/// into a colour-only distinction.
class DsHeroPanel extends StatelessWidget {
  const DsHeroPanel({
    super.key,
    required this.label,
    required this.value,
    this.base = DsColor.ink,
    this.icon,
    this.footnote,
  });

  final String label;
  final String value;
  final Color base;
  final IconData? icon;
  final String? footnote;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: DsSpace.xl, horizontal: DsSpace.lg),
      decoration: BoxDecoration(
        gradient: DsGradient.hero(base),
        borderRadius: DsRadius.lgBorder,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: DsIconSize.lg, color: DsColor.onDarkMuted),
            DsSpace.gapSm,
          ],
          Text(label, style: DsText.onDarkLabel(context), textAlign: TextAlign.center),
          DsSpace.gapSm,
          Text(value, style: DsText.onDarkDisplay(context), textAlign: TextAlign.center),
          if (footnote != null) ...[
            DsSpace.gapXs,
            Text(footnote!, style: DsText.onDarkBody(context), textAlign: TextAlign.center),
          ],
        ],
      ),
    );
  }
}

/// An icon + label + value row inside a card. `digital_twin_screen`,
/// `health_trend_screen`, `learning_progress_screen` and
/// `wellbeing_screen` each carried a private `_MetricRow`/`_MetricCard`
/// with this exact shape.
class DsMetricRow extends StatelessWidget {
  const DsMetricRow({
    super.key,
    required this.icon,
    required this.color,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final Color color;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return DsCard(
      child: Row(
        children: [
          Container(
            width: DsSize.touchTarget,
            height: DsSize.touchTarget,
            decoration: BoxDecoration(
              color: color.withOpacity(0.12),
              borderRadius: DsRadius.controlBorder,
            ),
            child: Icon(icon, color: color, size: DsIconSize.md),
          ),
          DsSpace.hGapMd,
          Expanded(child: Text(label, style: DsText.body(context))),
          DsSpace.hGapSm,
          Text(value, style: DsText.cardTitle(context)),
        ],
      ),
    );
  }
}

/// ONE GREY BLOCK THAT BREATHES.
///
/// The building brick of every skeleton. It pulses opacity rather than
/// sliding a shimmer gradient across itself: a shimmer repaints the full
/// width of the block every frame, and the cheap Android hardware this
/// product targets in Egypt renders that at a visibly worse frame rate
/// than a single opacity tween.
class DsSkeletonBlock extends StatefulWidget {
  const DsSkeletonBlock({
    super.key,
    this.width,
    this.height = 14,
    this.radius,
  });

  final double? width;
  final double height;
  final double? radius;

  @override
  State<DsSkeletonBlock> createState() => _DsSkeletonBlockState();
}

class _DsSkeletonBlockState extends State<DsSkeletonBlock>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: DsMotion.pulse,
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
          color: DsColor.hairline,
          borderRadius: BorderRadius.circular(widget.radius ?? DsRadius.sm),
        ),
      ),
    );
  }
}

/// THE SHAPE OF THE PAGE, BEFORE THE PAGE ARRIVES.
///
/// Replaces `Center(child: CircularProgressIndicator())` on every screen
/// whose layout is known in advance — which is all of them, because every
/// one of these screens renders a header and then a list of cards. A
/// spinner tells a parent "something is happening somewhere"; this tells
/// them what is about to be there and stops the content jumping when it
/// lands.
class DsSkeletonList extends StatelessWidget {
  const DsSkeletonList({
    super.key,
    this.rows = 4,
    this.hero = false,
    this.padding = DsSpace.screen,
  });

  final int rows;
  final bool hero;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    // A skeleton is decoration; the screen's own loading label is what a
    // screen reader should announce, not eleven grey rectangles.
    return ExcludeSemantics(
      child: SingleChildScrollView(
        padding: padding,
        physics: const NeverScrollableScrollPhysics(),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (hero) ...[
              const DsSkeletonBlock(height: 108, radius: DsRadius.lg),
              DsSpace.gapLg,
            ],
            for (int i = 0; i < rows; i++) ...[
              const _DsSkeletonCard(),
              DsSpace.gapMd,
            ],
          ],
        ),
      ),
    );
  }
}

class _DsSkeletonCard extends StatelessWidget {
  const _DsSkeletonCard();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: DsSpace.card,
      decoration: BoxDecoration(
        color: DsColor.surface,
        borderRadius: DsRadius.cardBorder,
        border: Border.all(color: DsColor.hairline),
      ),
      child: Row(
        children: [
          const DsSkeletonBlock(width: DsSize.touchTarget, height: DsSize.touchTarget, radius: DsRadius.control),
          DsSpace.hGapMd,
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: const [
                DsSkeletonBlock(height: 14),
                SizedBox(height: DsSpace.sm),
                DsSkeletonBlock(width: 140, height: 12),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
