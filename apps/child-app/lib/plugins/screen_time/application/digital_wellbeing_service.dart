import '../../../core/network/api_client.dart';
import '../../../core/platform/agent_channel.dart';
import '../../offline_queue/application/offline_queue.dart';
import '../../screen_time/contracts/i_app_usage_collector.dart';

/// Edge-First Intelligence Architecture — the local aggregation layer.
/// This is the ONE class in the Child App that decides what leaves
/// the device: a single daily summary, never raw per-app-open events.
///
/// PRIVACY DISCIPLINE (structural, not a promise): this class's
/// entire input surface is `IAppUsageCollector` (per-app minutes,
/// already-aggregated by Android itself) plus simple counters. There
/// is no code path here that could read message content, notification
/// text, keystrokes, or GPS.
///
/// SHARED-QUEUE SAFETY (found and fixed during design): `OfflineQueue`
/// is the SAME singleton instance `HeartbeatService` already queues
/// its own 'heartbeat' events into. `_sendQueuedEvent` below mirrors
/// HeartbeatService's own exact pattern: `switch` on `event.type`,
/// and THROW `StateError` for any type this class doesn't own —
/// matching `OfflineQueue.drain()`'s "stop at first failure" contract
/// exactly, so an unrelated producer's queued event is left safely in
/// the queue for ITS OWN drain call, never silently discarded here.
class DigitalWellbeingService {
  DigitalWellbeingService(this._usageCollector, this._apiClient, this._offlineQueue, this._channel);

  final IAppUsageCollector _usageCollector;
  final ApiClient _apiClient;
  final OfflineQueue _offlineQueue;
  final AgentPlatformChannel _channel;

  static const _dailySummaryType = 'wellbeing_daily_summary';
  static const _criticalEventType = 'wellbeing_critical_event';

  Future<void> buildAndQueueDailySummary({
    required int pickupCount,
    required int nightUsageMinutes,
    required int blockedAttemptCount,
  }) async {
    final usage = await _usageCollector.getTodayUsage();

    // Sprint 14 — CLOSES A REAL GAP: category data now enriches the
    // per-app breakdown before upload. Best-effort: if the category
    // lookup fails for any reason, the breakdown still uploads
    // without categories rather than failing the whole summary — the
    // raw minutes-per-app data (already working since an earlier
    // sprint) must never be blocked by this new, additive feature.
    Map<Object?, Object?> categories = const {};
    try {
      categories = await _channel.getTodayAppCategories();
    } catch (_) {
      // Best-effort, see comment above.
    }

    final totalMinutes = usage.values.fold<int>(0, (sum, d) => sum + d.inMinutes);
    final appBreakdown = usage.entries.map((e) {
      final category = categories[e.key] as String?;
      return {
        'packageName': e.key,
        'minutes': e.value.inMinutes,
        if (category != null) 'category': category,
      };
    }).toList();

    // Sprint 14 — session-level stats, same best-effort discipline as
    // categories above: the daily summary must still upload with its
    // existing fields even if this new data can't be collected for
    // some reason.
    int? sessionCount;
    int? averageSessionMinutes;
    int? longestSessionMinutes;
    try {
      final sessionStats = await _channel.getTodaySessionStats();
      sessionCount = sessionStats['sessionCount'] as int?;
      averageSessionMinutes = sessionStats['averageSessionMinutes'] as int?;
      longestSessionMinutes = sessionStats['longestSessionMinutes'] as int?;
    } catch (_) {
      // Best-effort, see comment above.
    }

    final today = DateTime.now();
    final usageDate =
        '${today.year.toString().padLeft(4, '0')}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';

    await _offlineQueue.enqueue(_dailySummaryType, {
      'usageDate': usageDate,
      'totalScreenMinutes': totalMinutes,
      'appBreakdown': appBreakdown,
      'pickupCount': pickupCount,
      'nightUsageMinutes': nightUsageMinutes,
      'blockedAttemptCount': blockedAttemptCount,
      if (sessionCount != null) 'sessionCount': sessionCount,
      if (averageSessionMinutes != null) 'averageSessionMinutes': averageSessionMinutes,
      if (longestSessionMinutes != null) 'longestSessionMinutes': longestSessionMinutes,
    });
  }

  Future<void> queueCriticalEvent({
    required String eventType,
    required String title,
    required String body,
    Map<String, dynamic>? metadata,
  }) async {
    await _offlineQueue.enqueue(_criticalEventType, {
      'eventType': eventType,
      'title': title,
      'body': body,
      if (metadata != null) 'metadata': metadata,
    });
  }

  /// Drains the queue for THIS service's two event types only.
  /// Mirrors HeartbeatService._sendQueuedEvent's exact contract.
  Future<int> drainOwnEvents() async {
    return _offlineQueue.drain((event) => _sendQueuedEvent(event));
  }

  Future<void> _sendQueuedEvent(QueuedEvent event) async {
    switch (event.type) {
      case _dailySummaryType:
        await _apiClient.post('/life-intelligence/self/wellbeing/daily-summary', body: event.payload);
        break;
      case _criticalEventType:
        await _apiClient.post('/life-intelligence/self/wellbeing/critical-event', body: event.payload);
        break;
      default:
        throw StateError('Unknown queued event type for DigitalWellbeingService: ${event.type}');
    }
  }
}
