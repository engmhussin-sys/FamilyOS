import 'dart:math';
import 'package:flutter/material.dart';

import '../theme/kid_theme.dart';

/// A real celebration animation — particles that burst and fall,
/// triggered by calling [CelebrationOverlay.of(context).burst()].
/// Built with a plain AnimationController + CustomPainter rather than
/// an external confetti package — this app already keeps its
/// dependency list deliberately small (see pubspec.yaml's own
/// comments), and a burst of colored circles/rects is simple enough
/// to not need a third-party package for it.
class CelebrationOverlay extends StatefulWidget {
  const CelebrationOverlay({super.key, required this.child});

  final Widget child;

  static CelebrationOverlayState of(BuildContext context) {
    final state = context.findAncestorStateOfType<CelebrationOverlayState>();
    assert(state != null, 'CelebrationOverlay.of() called with no CelebrationOverlay ancestor');
    return state!;
  }

  @override
  State<CelebrationOverlay> createState() => CelebrationOverlayState();
}

class CelebrationOverlayState extends State<CelebrationOverlay> with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  final List<_Particle> _particles = [];
  final _random = Random();

  static const _colors = [
    KidTheme.sunshineYellow,
    KidTheme.skyBlue,
    KidTheme.leafGreen,
    KidTheme.berryPurple,
    KidTheme.coral,
  ];

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))
      ..addListener(() => setState(() {}));
  }

  /// Call this from anywhere below this widget in the tree to trigger
  /// a burst of confetti from roughly the top-center of the screen —
  /// intentionally simple (no origin parameter): every celebration on
  /// this screen is a whole-screen "you did it!" moment, not a
  /// precisely-targeted effect anchored to one button.
  void burst() {
    _particles.clear();
    for (var i = 0; i < 24; i++) {
      _particles.add(_Particle(
        color: _colors[_random.nextInt(_colors.length)],
        startX: _random.nextDouble(),
        velocityX: (_random.nextDouble() - 0.5) * 1.2,
        velocityY: 0.5 + _random.nextDouble() * 0.5,
        size: 6 + _random.nextDouble() * 8,
        rotationSpeed: (_random.nextDouble() - 0.5) * 8,
        isCircle: _random.nextBool(),
      ));
    }
    _controller.forward(from: 0);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        widget.child,
        if (_controller.isAnimating)
          Positioned.fill(
            child: IgnorePointer(
              child: CustomPaint(
                painter: _ConfettiPainter(particles: _particles, progress: _controller.value),
              ),
            ),
          ),
      ],
    );
  }
}

class _Particle {
  _Particle({
    required this.color,
    required this.startX,
    required this.velocityX,
    required this.velocityY,
    required this.size,
    required this.rotationSpeed,
    required this.isCircle,
  });

  final Color color;
  final double startX; // 0.0-1.0, fraction of screen width
  final double velocityX;
  final double velocityY;
  final double size;
  final double rotationSpeed;
  final bool isCircle;
}

class _ConfettiPainter extends CustomPainter {
  _ConfettiPainter({required this.particles, required this.progress});

  final List<_Particle> particles;
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    for (final p in particles) {
      // Ease-out fall with a slight fade near the end — a real physical
      // "settle" feel rather than a linear, mechanical drop.
      final t = progress;
      final fadeStart = 0.7;
      final opacity = t < fadeStart ? 1.0 : (1.0 - (t - fadeStart) / (1 - fadeStart)).clamp(0.0, 1.0);

      final x = (p.startX * size.width) + (p.velocityX * size.width * t);
      final y = (size.height * 0.15) + (p.velocityY * size.height * t * t * 1.8);
      final rotation = p.rotationSpeed * t * pi;

      final paint = Paint()..color = p.color.withOpacity(opacity);
      canvas.save();
      canvas.translate(x, y);
      canvas.rotate(rotation);
      if (p.isCircle) {
        canvas.drawCircle(Offset.zero, p.size / 2, paint);
      } else {
        canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromCenter(center: Offset.zero, width: p.size, height: p.size * 0.6), const Radius.circular(2)),
          paint,
        );
      }
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(covariant _ConfettiPainter oldDelegate) => true;
}
