/// Decision-016's `IPermissionManager`. Owns the "does the user need to
/// grant/enable something, and how do we ask" concern — distinct from
/// ICapabilityProvider, which only reports current state. This is the
/// mutating/action-taking counterpart; ICapabilityProvider is read-only.
abstract class IPermissionManager {
  /// Every permission this plugin knows how to request, in the
  /// recommended onboarding order — mandatory ones (ADR §5) before
  /// optional ones (§6).
  List<AgentPermission> get allKnownPermissions;

  /// Deep-links to the relevant system settings screen for [permission]
  /// — most of these are NOT standard runtime-permission dialogs (see
  /// child-agent-android-enforcement.md §5's "special access, manual
  /// toggle" column), so this is a settings-screen launch, not a
  /// programmatic grant.
  Future<void> requestPermission(AgentPermission permission);

  /// Fresh state check (not cached — see ICapabilityProvider for the
  /// cached view) for one specific permission.
  Future<bool> isGranted(AgentPermission permission);
}

enum AgentPermission {
  usageAccess,
  accessibilityService,
  overlay,
  postNotifications,
  batteryOptimizationExemption,
  // Optional, feature-gated (ADR §6) — only requested if the
  // corresponding plugin (gps) is enabled for this family.
  fineLocation,
  backgroundLocation,
}
