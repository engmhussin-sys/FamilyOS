import '../../../core/platform/agent_channel.dart';
import '../contracts/i_app_usage_collector.dart';

/// CLOSES A REAL GAP: `IAppUsageCollector` (Decision-016) has existed
/// as a contract with zero implementation. This is that
/// implementation — reads Android's own already-aggregated
/// UsageStatsManager data via the platform channel, never per-tap or
/// per-second data.
class PlatformAppUsageCollector implements IAppUsageCollector {
  PlatformAppUsageCollector(this._channel);

  final AgentPlatformChannel _channel;

  @override
  Future<Map<String, Duration>> getTodayUsage() async {
    final raw = await _channel.getTodayAppUsageBreakdown();
    final result = <String, Duration>{};
    for (final entry in raw.entries) {
      final packageName = entry.key as String?;
      final minutes = entry.value;
      if (packageName == null) continue;
      final minutesInt = minutes is int ? minutes : int.tryParse('$minutes') ?? 0;
      result[packageName] = Duration(minutes: minutesInt);
    }
    return result;
  }

  @override
  Future<void> reconcileWithSystemUsageStats() async {
    // Honest scope note: today's usage IS read fresh from
    // UsageStatsManager on every getTodayUsage() call — there is no
    // separate locally-tracked running total yet to reconcile
    // against (that would need a live foreground-app watcher, Track
    // B's Foreground Runtime, documented as not yet built). This
    // method exists to satisfy the contract now rather than leave it
    // unimplemented, and becomes meaningful the moment that live
    // tracker exists — no caller needs to change.
  }
}
