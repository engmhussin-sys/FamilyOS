import 'dart:async';

import 'package:flutter/widgets.dart';

/// FOREGROUND TIME MEASUREMENT — closes audit PA-M-003 (🔴 High).
///
/// The finding: "استراتيجية `DURATION` تتطلب `foregroundMinutes` من الجهاز؛
/// لا آلية قياس. أي برنامج بهذه الطريقة سيُرفَض دائمًا" — there was no
/// `WidgetsBindingObserver` and no foreground counter anywhere in the Child
/// App, so every `DURATION` program was structurally unsatisfiable.
///
/// WHAT THIS IS AND, CRUCIALLY, WHAT IT IS NOT.
///
/// It is a stopwatch that ONLY runs while the app is in the foreground. It
/// pauses on `inactive`/`paused`/`hidden`/`detached` and resumes on
/// `resumed`, so minutes spent with the phone in a pocket do not count.
/// That is precisely what `VERIFICATION_MATRIX.DURATION` describes: «يعتمد
/// على زمن الواجهة الأمامية (foreground) لا على ساعة الحائط».
///
/// It is NOT a source of truth and it is NOT trusted. What it produces is
/// EVIDENCE, submitted as `foregroundMinutes`, and the server clamps it:
/// `checkDuration` rejects any value exceeding the elapsed wall-clock time
/// it measured from its own `startedAt` (`FOREGROUND_EXCEEDS_ELAPSED`).
/// A tampered counter cannot buy a reward; it can only fail to earn one.
///
/// It is also NOT a completion signal. Reaching the target does not submit,
/// does not verify, and does not grant. The child still presses the button
/// and the server still runs the strategy.
class ForegroundStopwatch with WidgetsBindingObserver {
  ForegroundStopwatch({this.onTick});

  /// Fired roughly once per second while running, so a screen can rebuild a
  /// timer without owning a `Timer` of its own.
  final VoidCallback? onTick;

  final Stopwatch _stopwatch = Stopwatch();
  Timer? _ticker;
  bool _attached = false;

  /// Accumulated FOREGROUND time.
  Duration get elapsed => _stopwatch.elapsed;

  int get elapsedMinutes => _stopwatch.elapsed.inMinutes;

  int get elapsedSeconds => _stopwatch.elapsed.inSeconds;

  bool get isRunning => _stopwatch.isRunning;

  void start() {
    if (!_attached) {
      WidgetsBinding.instance.addObserver(this);
      _attached = true;
    }
    _stopwatch.start();
    _ticker ??= Timer.periodic(const Duration(seconds: 1), (_) => onTick?.call());
  }

  void pause() => _stopwatch.stop();

  void stop() {
    _stopwatch.stop();
    _ticker?.cancel();
    _ticker = null;
  }

  void dispose() {
    stop();
    if (_attached) {
      WidgetsBinding.instance.removeObserver(this);
      _attached = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (_ticker != null) _stopwatch.start();
    } else {
      // inactive | paused | hidden | detached — all of them mean the child
      // is not looking at this screen, so none of them may accrue time.
      _stopwatch.stop();
    }
  }
}
