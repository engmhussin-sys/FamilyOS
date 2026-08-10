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

/// CLOSING A REAL GAP found during Sprint 23's hardening pass:
/// `checkForTampering()` was correctly detecting these signals since
/// Sprint 4, but nothing ever converted them into the exact shape the
/// backend's `RiskSignalsDto` (`/pairing/verify`) expects, so they
/// never reached `RiskEvaluationService`'s real, working risk scoring.
/// This mapping is that missing translation.
///
/// Honest, explicit choices, not hidden assumptions:
/// - `isUnsupportedDevice`/`isOldAndroidVersion` are hardcoded `false`
///   here \u2014 this project's own `ENVIRONMENT_SETUP.md` marks the real
///   minimum supported Android SDK version as
///   "TO BE VERIFIED DURING FIRST BUILD" (no `build.gradle` exists yet
///   to read a real `minSdkVersion` from). Inventing a threshold
///   number here would be a guess dressed up as a real check \u2014 once a
///   real `minSdkVersion` exists, this should compare against the
///   device's actual `sdkInt` (already collected in
///   `PairingCapabilitySnapshotDto` elsewhere in the pairing flow).
/// - `hasTamperIndicators` is true when either accessibility or usage
///   access has been actively disabled \u2014 signals about the CHILD
///   actively defeating protection, distinct from device-level root/
///   emulator signals which have their own dedicated fields below.
/// - `missingAttestation` is left `false` here \u2014 attestation-chain
///   presence is decided by whether `attestationChain` itself was sent
///   on the `verify()` call, not derived from these tamper signals; a
///   caller combining both should not double-set this field.
Map<String, bool> tamperSignalsToRiskSignalsDto(List<TamperSignal> signals) {
  final present = signals.toSet();
  return {
    'isEmulator': present.contains(TamperSignal.emulatorDetected),
    'isRooted': present.contains(TamperSignal.rootDetected),
    'hasTamperIndicators': present.contains(TamperSignal.accessibilityDisabled) ||
        present.contains(TamperSignal.usageAccessDisabled),
    'isUnsupportedDevice': false,
    'missingAttestation': false,
    'mockLocationEnabled': present.contains(TamperSignal.mockLocationDetected),
    'developerModeEnabled': present.contains(TamperSignal.developerModeEnabled),
    'usbDebuggingEnabled': present.contains(TamperSignal.usbDebuggingEnabled),
    'isOldAndroidVersion': false,
  };
}
