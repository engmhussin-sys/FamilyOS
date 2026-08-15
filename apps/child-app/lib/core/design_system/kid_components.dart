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
      height: 64,
      child: FilledButton(
        onPressed: busy ? null : onPressed,
        style: FilledButton.styleFrom(
          backgroundColor: color ?? KidColor.success,
          shape: RoundedRectangleBorder(borderRadius: KidRadius.controlBorder),
        ),
        child: busy
            ? const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white),
              )
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (icon != null) ...[Icon(icon, size: 24), KidSpace.hGapSm],
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
      height: 56,
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
            if (icon != null) ...[Icon(icon, size: 20), KidSpace.hGapSm],
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
          if (icon != null) ...[Icon(icon, size: 15, color: c), const SizedBox(width: KidSpace.xs)],
          Text(label, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c)),
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
          if (icon != null) ...[Icon(icon, size: 26, color: c), KidSpace.gapXs],
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
