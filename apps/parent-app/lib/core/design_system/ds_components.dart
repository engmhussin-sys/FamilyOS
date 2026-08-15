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
                    size: 20,
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
          if (icon != null) ...[Icon(icon, size: 13, color: c), const SizedBox(width: DsSpace.xs)],
          Text(
            label,
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c),
          ),
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
