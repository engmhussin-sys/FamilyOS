import 'dart:math';
import 'package:flutter/material.dart';

import '../theme/kid_theme.dart';

/// A circular progress ring showing "how much of today is done" at a
/// glance — the single most important piece of visual feedback on the
/// home screen, deliberately given the most prominent spot (top of
/// the screen, large) rather than buried as one stat among many.
class DailyProgressRing extends StatelessWidget {
  const DailyProgressRing({
    super.key,
    required this.completed,
    required this.total,
    required this.childName,
  });

  final int completed;
  final int total;
  final String childName;

  @override
  Widget build(BuildContext context) {
    final ratio = total > 0 ? (completed / total).clamp(0.0, 1.0) : 0.0;
    final allDone = total > 0 && completed >= total;

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [KidTheme.skyBlue.withOpacity(0.15), KidTheme.berryPurple.withOpacity(0.10)],
        ),
        borderRadius: BorderRadius.circular(28),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 88,
            height: 88,
            child: TweenAnimationBuilder<double>(
              tween: Tween(begin: 0, end: ratio),
              duration: const Duration(milliseconds: 800),
              curve: Curves.easeOutCubic,
              builder: (context, value, _) => CustomPaint(
                painter: _RingPainter(progress: value, allDone: allDone),
                child: Center(
                  child: allDone
                      ? const Text('\u{1F31F}', style: TextStyle(fontSize: 32))
                      : Text(
                          total > 0 ? '$completed/$total' : '-',
                          style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                        ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 18),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  allDone ? 'Amazing, $childName!' : 'Hi $childName!',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 4),
                Text(
                  allDone
                      ? 'You finished everything today!'
                      : total > 0
                          ? "Let's finish today's list!"
                          : 'Nothing to do yet today.',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
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
