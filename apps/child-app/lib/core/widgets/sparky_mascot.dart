import 'dart:math';
import 'package:flutter/material.dart';

import '../theme/kid_theme.dart';

/// "Sparky" — the app's friendly mascot, drawn entirely with basic
/// shapes rather than an imported illustration/SVG asset. Deliberate
/// choice: zero new binary assets to manage, and a simple
/// rounded-star character reads clearly at any size without needing
/// a real illustrator's artwork to look intentional rather than crude.
///
/// [mood] changes the expression — used to react to context (e.g.
/// happier after a celebration) without needing multiple image files.
enum SparkyMood { neutral, happy, celebrating }

class SparkyMascot extends StatelessWidget {
  const SparkyMascot({super.key, this.mood = SparkyMood.neutral, this.size = 72});

  final SparkyMood mood;
  final double size;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _SparkyPainter(mood: mood)),
    );
  }
}

class _SparkyPainter extends CustomPainter {
  _SparkyPainter({required this.mood});

  final SparkyMood mood;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final r = size.width / 2;

    // Body — a soft rounded-star shape (5 points)
    final bodyPaint = Paint()..color = KidTheme.sunshineYellow;
    final path = Path();
    const points = 5;
    for (var i = 0; i < points * 2; i++) {
      final isOuter = i.isEven;
      final radius = isOuter ? r : r * 0.62;
      final angle = (i * pi / points) - pi / 2;
      final x = center.dx + radius * cos(angle);
      final y = center.dy + radius * sin(angle);
      if (i == 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    path.close();
    canvas.drawPath(path, bodyPaint);

    // Cheeks
    final cheekPaint = Paint()..color = KidTheme.coral.withOpacity(0.5);
    canvas.drawCircle(Offset(center.dx - r * 0.42, center.dy + r * 0.08), r * 0.14, cheekPaint);
    canvas.drawCircle(Offset(center.dx + r * 0.42, center.dy + r * 0.08), r * 0.14, cheekPaint);

    // Eyes
    final eyePaint = Paint()..color = KidTheme.softInk;
    if (mood == SparkyMood.celebrating) {
      final eyeStroke = Paint()
        ..color = KidTheme.softInk
        ..style = PaintingStyle.stroke
        ..strokeWidth = r * 0.09
        ..strokeCap = StrokeCap.round;
      canvas.drawArc(Rect.fromCenter(center: Offset(center.dx - r * 0.22, center.dy - r * 0.05), width: r * 0.28, height: r * 0.28), 3.6, 2.2, false, eyeStroke);
      canvas.drawArc(Rect.fromCenter(center: Offset(center.dx + r * 0.22, center.dy - r * 0.05), width: r * 0.28, height: r * 0.28), 3.6, 2.2, false, eyeStroke);
    } else {
      canvas.drawCircle(Offset(center.dx - r * 0.22, center.dy - r * 0.05), r * 0.09, eyePaint);
      canvas.drawCircle(Offset(center.dx + r * 0.22, center.dy - r * 0.05), r * 0.09, eyePaint);
    }

    // Mouth
    final mouthPaint = Paint()
      ..color = KidTheme.softInk
      ..style = PaintingStyle.stroke
      ..strokeWidth = r * 0.08
      ..strokeCap = StrokeCap.round;
    final mouthWidth = mood == SparkyMood.neutral ? r * 0.28 : r * 0.4;
    final mouthDepth = mood == SparkyMood.neutral ? r * 0.06 : r * 0.18;
    final mouthPath = Path()
      ..moveTo(center.dx - mouthWidth, center.dy + r * 0.28)
      ..quadraticBezierTo(center.dx, center.dy + r * 0.28 + mouthDepth, center.dx + mouthWidth, center.dy + r * 0.28);
    canvas.drawPath(mouthPath, mouthPaint);
  }

  @override
  bool shouldRepaint(covariant _SparkyPainter oldDelegate) => oldDelegate.mood != mood;
}
