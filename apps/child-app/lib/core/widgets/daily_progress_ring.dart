import 'dart:math';
import 'package:flutter/material.dart';

import '../design_system/design_system.dart';
import '../theme/kid_theme.dart';

/// A circular progress ring showing "how much of today is done" at a
/// glance — the single most important piece of visual feedback on the
/// home screen, deliberately given the most prominent spot (top of
/// the screen, large) rather than buried as one stat among many.
/// EVERY SENTENCE IS PASSED IN, AND THAT IS THE FIX.
///
/// This widget used to hold five HARDCODED ENGLISH strings — "Hi
/// {name}!", "Amazing, {name}!", "You finished everything today!",
/// "Let's finish today's list!", "Nothing to do yet today." — on the
/// single most prominent surface of the child's daily screen, in a
/// product whose default language is Arabic. `verify_l10n_parity.py`
/// could never see them: they were string literals, not `t('...')` call
/// sites. They are now resolved by the caller, exactly as every widget in
/// `kid_states.dart` already does it.
class DailyProgressRing extends StatelessWidget {
  const DailyProgressRing({
    super.key,
    required this.completed,
    required this.total,
    required this.greeting,
    required this.encouragement,
    required this.allDoneSemanticLabel,
  });

  final int completed;
  final int total;

  /// Already localised and already interpolated with the child's name.
  final String greeting;
  final String encouragement;

  /// What a screen reader says in place of the finished-everything mark.
  final String allDoneSemanticLabel;

  @override
  Widget build(BuildContext context) {
    final ratio = total > 0 ? (completed / total).clamp(0.0, 1.0) : 0.0;
    final allDone = total > 0 && completed >= total;

    return Container(
      padding: const EdgeInsets.symmetric(vertical: KidSpace.xl, horizontal: KidSpace.lg),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: AlignmentDirectional.topStart,
          end: AlignmentDirectional.bottomEnd,
          colors: [KidTheme.skyBlue.withOpacity(0.15), KidTheme.berryPurple.withOpacity(0.10)],
        ),
        borderRadius: BorderRadius.circular(KidRadius.lg),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 96,
            height: 96,
            child: TweenAnimationBuilder<double>(
              tween: Tween(begin: 0, end: ratio),
              duration: const Duration(milliseconds: 800),
              curve: Curves.easeOutCubic,
              builder: (context, value, _) => CustomPaint(
                painter: _RingPainter(progress: value, allDone: allDone),
                child: Center(
                  child: allDone
                      // WAS `Text('\u{1F31F}')` — "you finished everything"
                      // stated only in an emoji font, which a cheap Android
                      // device may draw as a grey outline or a tofu box, and
                      // which a screen reader reads as "glowing star". A
                      // Material glyph ships inside the app and carries a
                      // real label.
                      ? Semantics(
                          label: allDoneSemanticLabel,
                          child: const Icon(
                            Icons.star_rounded,
                            size: KidSize.iconHero,
                            color: KidColor.highlight,
                          ),
                        )
                      : Text(
                          total > 0 ? '$completed/$total' : '-',
                          style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                        ),
                ),
              ),
            ),
          ),
          const SizedBox(width: KidSpace.lg),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(greeting, style: KidText.sectionTitle(context)),
                KidSpace.gapXs,
                Text(encouragement, style: KidText.caption(context)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({required this.progress, required this.allDone});

  final double progress;
  final bool allDone;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.width / 2 - 6;

    final trackPaint = Paint()
      ..color = KidTheme.mutedInk.withOpacity(0.15)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 8
      ..strokeCap = StrokeCap.round;
    canvas.drawCircle(center, radius, trackPaint);

    final progressPaint = Paint()
      ..shader = SweepGradient(
        colors: allDone
            ? [KidTheme.sunshineYellow, KidTheme.coral, KidTheme.sunshineYellow]
            : [KidTheme.skyBlue, KidTheme.leafGreen],
      ).createShader(Rect.fromCircle(center: center, radius: radius))
      ..style = PaintingStyle.stroke
      ..strokeWidth = 8
      ..strokeCap = StrokeCap.round;

    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -pi / 2,
      2 * pi * progress,
      false,
      progressPaint,
    );
  }

  @override
  bool shouldRepaint(covariant _RingPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.allDone != allDone;
}
