/// Decision-016's `IAntiTamper`, covering every signal Decision-008 listed
/// explicitly. Per the lifecycle ADR's honesty throughout: this interface
/// is about DETECTION and REPORTING, not prevention — see
/// child-agent-android-enforcement.md §10 and lifecycle ADR §5 for why
/// true prevention needs Device Owner mode, which is optional/Enhanced
/// Mode only, not assumed here.
abstract class IAntiTamper {
  /// Runs every check in [TamperSignal] and returns only the ones
  /// currently detected as true/active — an empty list means "nothing
  /// detected," not "nothing was checked."
  Future<List<TamperSignal>> checkForTampering();

  /// Continuous stream — some signals (service disabled, force-stop-via-
  /// heartbeat-gap) are only meaningfully detected as state transitions,
  /// not point-in-time checks.
  Stream<TamperSignal> get signalDetected;
}

enum TamperSignal {
  serviceDisabled,
  accessibilityDisabled,
  usageAccessDisabled,
  appForceStopped,
  apkReinstalled,
  deviceRebooted,
  permissionsRevoked,
  timeManipulationDetected,
  factoryResetDetected,
  rootDetected,
  mockLocationDetected,
  emulatorDetected,
  developerModeEnabled,
  usbDebuggingEnabled,
}
