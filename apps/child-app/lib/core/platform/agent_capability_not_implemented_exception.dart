/// Thrown when Dart calls a platform-channel method that the native
/// Android side legitimately doesn't implement yet (returns
/// `result.notImplemented()`). Kept distinct from a generic
/// PlatformException so calling code — and future ADR-step
/// implementations — can tell "this feature doesn't exist yet" apart from
/// "this feature exists and genuinely failed."
class AgentCapabilityNotImplementedException implements Exception {
  AgentCapabilityNotImplementedException(this.methodName);

  final String methodName;

  @override
  String toString() =>
      'AgentCapabilityNotImplementedException: "$methodName" is not yet implemented on the native side.';
}
