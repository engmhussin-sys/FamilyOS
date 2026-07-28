/// Decision-016's `ICapabilityProvider`. Placed under `core/contracts/`,
/// not a plugin folder — every plugin needs to ask "can I actually do my
/// job on this device?" (Decision-007's Capability-Based Engine
/// principle), which makes this cross-cutting infrastructure rather than
/// a toggleable feature.
///
/// The concrete implementation (Step 4: Capability Engine) is responsible
/// for the caching/hashing behavior from Decision-019 — this interface
/// only defines the query surface, not the caching strategy.
abstract class ICapabilityProvider {
  /// Returns the current, possibly-cached capability profile. Callers
  /// that need a guaranteed-fresh read (e.g. right before attempting an
  /// enforcement action) should use [refresh] first.
  Future<CapabilityProfile> getProfile();

  /// Forces a full device re-scan, bypassing the cache, and returns the
  /// new profile. Emits a CapabilityChangedEvent on the Event Bus if the
  /// result differs from the previously cached one (Decision-019).
  Future<CapabilityProfile> refresh();
}

/// Field set expanded per Decision-006 — the reviewer's explicit
/// expansion of the original Capability Engine scope. Kept here as a
/// plain data class (not `freezed`) for the same code-generation
/// limitation noted in agent_event.dart.
class CapabilityProfile {
  const CapabilityProfile({
    required this.deviceProfile,
    required this.osProfile,
    required this.permissionProfile,
    required this.vendorRestrictions,
    required this.performanceTier,
    required this.profileHash,
  });

  final DeviceProfile deviceProfile;
  final OsProfile osProfile;
  final PermissionProfile permissionProfile;
  final VendorRestrictions vendorRestrictions;
  final PerformanceTier performanceTier;

  /// SHA-based hash of the profile's contents (Decision-019) — compared
  /// against the previously cached hash to decide whether anything
  /// actually changed before bothering the server with an update.
  final String profileHash;
}

class DeviceProfile {
  const DeviceProfile({
    required this.manufacturer,
    required this.model,
    required this.apiLevel,
    this.cpuInfo,
    this.ramMb,
    this.batteryCapacityMah,
    this.screenSizeInches,
  });

  final String manufacturer;
  final String model;
  final int apiLevel;
  final String? cpuInfo;
  final int? ramMb;
  final int? batteryCapacityMah;
  final double? screenSizeInches;
}

class OsProfile {
  const OsProfile({
    required this.androidVersion,
    this.securityPatchLevel,
    this.googlePlayServicesVersion,
  });

  final String androidVersion;
  final String? securityPatchLevel;
  final String? googlePlayServicesVersion;
}

class PermissionProfile {
  const PermissionProfile({
    required this.accessibilityEnabled,
    required this.usageAccessGranted,
    required this.overlayGranted,
    required this.notificationAccessGranted,
    required this.batteryOptimizationExempted,
    required this.backgroundRestricted,
  });

  final bool accessibilityEnabled;
  final bool usageAccessGranted;
  final bool overlayGranted;
  final bool notificationAccessGranted;
  final bool batteryOptimizationExempted;
  /// See lifecycle ADR §7 — there is no fully reliable public API for
  /// this across all OS/OEM combinations; this field is best-effort.
  final bool backgroundRestricted;
}

enum KnownVendor { samsung, xiaomi, huawei, oppo, vivo, realme, honor, motorola, oneplus, other }

class VendorRestrictions {
  const VendorRestrictions({required this.vendor, required this.hasKnownBackgroundRestrictions});

  final KnownVendor vendor;
  /// True for vendors with documented aggressive background-kill
  /// behavior (Decision-006's explicit list) — drives whether the
  /// Permission Manager (Step 5) shows vendor-specific whitelist
  /// instructions during onboarding.
  final bool hasKnownBackgroundRestrictions;
}

enum PerformanceTier { lowEnd, medium, highEnd }
