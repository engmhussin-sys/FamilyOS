/// Decision-016's `IAppUsageCollector`. Lives under plugins/screen_time —
/// usage collection exists to feed screen-time enforcement and daily
/// reporting; it is not a standalone concern in this project's scope.
///
/// Deliberately returns aggregated per-app-per-day totals, mirroring the
/// backend's AppUsageLog table design (see docs/database/README.md §3.3:
/// "No raw content storage — aggregation over surveillance") — this
/// contract structurally cannot return per-event/per-tap data, by design,
/// not by omission.
abstract class IAppUsageCollector {
  /// Today's accumulated usage per package, updated in near-real-time as
  /// the enforcement loop (Step 11, AccessibilityService-driven) observes
  /// foreground-app changes.
  Future<Map<String, Duration>> getTodayUsage();

  /// Reconciles locally-tracked usage against `UsageStatsManager`'s own
  /// records — the defense-in-depth check described in the Android
  /// enforcement ADR §3, run periodically to backfill any usage that
  /// happened while the Agent process wasn't alive to track it live.
  Future<void> reconcileWithSystemUsageStats();
}
