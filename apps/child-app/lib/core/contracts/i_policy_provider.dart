/// Decision-016's `IPolicyProvider`. Core, not plugin-scoped — screen
/// time, app blocking, and (later) health/education modules all need "what
/// policy currently applies," so this lives alongside ICapabilityProvider
/// rather than inside plugins/screen_time specifically.
abstract class IPolicyProvider {
  /// Returns the currently-active policy for a child, preferring the
  /// latest synced version. Per Decision-011 (Offline Mode), if no
  /// network is available this MUST return the last successfully synced
  /// policy from local storage, not fail — enforcement continuing to work
  /// offline depends on this contract, not on the Sync Engine's internals.
  Future<ChildPolicy?> getCurrentPolicy(String childId);

  /// True if [getCurrentPolicy] is currently serving a locally-cached
  /// policy because the last sync attempt failed — surfaced to the UI/
  /// Observability layer so "policy might be stale" is visible, not hidden.
  Future<bool> isServingStalePolicy(String childId);
}

/// Minimal placeholder shape — will be expanded once Step 8 (Policy
/// Engine) is actually built against the backend's real
/// ScreenTimePolicy/AppBlockRule response shapes. Declared here only so
/// IPolicyProvider's signature is concrete rather than `dynamic`.
class ChildPolicy {
  const ChildPolicy({
    required this.childId,
    required this.dailyLimitMinutes,
    required this.syncedAt,
  });

  final String childId;
  final int? dailyLimitMinutes;
  final DateTime syncedAt;
}
