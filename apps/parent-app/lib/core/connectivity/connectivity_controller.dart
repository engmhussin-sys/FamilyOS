import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Closes the "mandatory before release" gap from the Production
/// Readiness Review: real connectivity monitoring, not just a clearer
/// error message after a request times out. Exposes a simple
/// `isOnline` boolean stream — `ConnectivityResult.none` means
/// genuinely offline; every other result is treated as online. Does
/// NOT attempt to verify actual internet reachability (a ping to a
/// known host) beyond what `connectivity_plus` reports — a device can
/// be "connected" to wifi with no internet access — that's a real,
/// separate improvement not attempted here to keep this fix scoped to
/// the specific gap named in the review.
class ConnectivityController extends StateNotifier<bool> {
  ConnectivityController(this._connectivity) : super(true) {
    _init();
  }

  final Connectivity _connectivity;
  StreamSubscription<List<ConnectivityResult>>? _subscription;

  Future<void> _init() async {
    final initial = await _connectivity.checkConnectivity();
    state = _isOnline(initial);

    _subscription = _connectivity.onConnectivityChanged.listen((results) {
      state = _isOnline(results);
    });
  }

  bool _isOnline(List<ConnectivityResult> results) {
    return results.any((r) => r != ConnectivityResult.none);
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }
}

final connectivityControllerProvider = StateNotifierProvider<ConnectivityController, bool>(
  (ref) => ConnectivityController(Connectivity()),
);
