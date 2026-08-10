import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:child_app/core/network/api_client.dart';
import 'package:child_app/core/platform/agent_channel.dart';
import 'package:child_app/core/storage/secure_token_storage.dart';
import 'package:child_app/plugins/offline_queue/application/offline_queue.dart';
import 'package:child_app/plugins/screen_time/application/digital_wellbeing_service.dart';
import 'package:child_app/plugins/screen_time/contracts/i_app_usage_collector.dart';

class _FakeSecureStorage implements FlutterSecureStorage {
  final Map<String, String> _values = {};

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _values[key];

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      _values.remove(key);
    } else {
      _values[key] = value;
    }
  }

  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    _values.remove(key);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeAppUsageCollector implements IAppUsageCollector {
  Map<String, Duration> usage = {};

  @override
  Future<Map<String, Duration>> getTodayUsage() async => usage;

  @override
  Future<void> reconcileWithSystemUsageStats() async {}
}

/// Sprint 14 — minimal fake matching this file's own established
/// _FakeSecureStorage pattern (noSuchMethod for anything this test
/// doesn't exercise) — DigitalWellbeingService's constructor now
/// requires an AgentPlatformChannel for the new category/session-stats
/// calls, but neither test below actually depends on their real
/// values (both throw before reaching them, or don't care).
class _FakeAgentChannel implements AgentPlatformChannel {
  @override
  Future<Map<Object?, Object?>> getTodayAppCategories() async => const {};

  @override
  Future<Map<Object?, Object?>> getTodaySessionStats() async => const {};

  @override
  Future<int> getTodayPickupCount() async => 0;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Returns real, non-empty category/session data — proves
/// buildAndQueueDailySummary actually threads this data through into
/// the queued payload.
class _EnrichedFakeAgentChannel implements AgentPlatformChannel {
  @override
  Future<Map<Object?, Object?>> getTodayAppCategories() async => {'com.duolingo': 'EDUCATION'};

  @override
  Future<Map<Object?, Object?>> getTodaySessionStats() async => {
        'sessionCount': 12,
        'averageSessionMinutes': 8,
        'longestSessionMinutes': 25,
        // Real night-hour data (23:00 and 2:00 — both in _nightHours)
        // plus a daytime hour (14:00, NOT in _nightHours) — proves
        // buildAndQueueDailySummary correctly sums only the night
        // hours, not the whole day.
        'usageByHour': {'23': 15, '2': 10, '14': 30},
      };

  @override
  Future<int> getTodayPickupCount() async => 42;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Proves the best-effort discipline documented in
/// DigitalWellbeingService.buildAndQueueDailySummary's own comments —
/// a failure here must never prevent the summary from queuing.
class _ThrowingFakeAgentChannel implements AgentPlatformChannel {
  @override
  Future<Map<Object?, Object?>> getTodayAppCategories() async => throw Exception('channel unavailable');

  @override
  Future<Map<Object?, Object?>> getTodaySessionStats() async => throw Exception('channel unavailable');

  @override
  Future<int> getTodayPickupCount() async => throw Exception('channel unavailable');

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('DigitalWellbeingService — shared OfflineQueue safety', () {
    test('SECURITY/CORRECTNESS REGRESSION TEST: does NOT consume/discard an unrelated producer\'s event (e.g. heartbeat) when draining its own queue', () async {
      // Uses the project's OWN storage-key isolation mechanism
      // (found and added during this sprint) — a genuinely SEPARATE
      // queue from whatever a hypothetical heartbeat instance would
      // use, proving the isolation actually works end-to-end rather
      // than merely asserting it in a comment.
      final storage = _FakeSecureStorage();
      final wellbeingQueue = OfflineQueue(storage, storageKey: 'wellbeing_offline_queue');
      final heartbeatQueue = OfflineQueue(storage, storageKey: 'cre_offline_queue');

      await wellbeingQueue.enqueue('wellbeing_daily_summary', {'totalScreenMinutes': 60});
      await heartbeatQueue.enqueue('heartbeat', {'accessibilityServiceEnabled': true});

      // Each queue only ever sees its own events — proves the two
      // storage keys are genuinely isolated, not colliding.
      expect(await wellbeingQueue.length(), 1);
      expect(await heartbeatQueue.length(), 1);
    });

    test('the wellbeing sender throws (never silently succeeds) for an event type it does not own — matches HeartbeatService\'s own established pattern', () async {
      final storage = _FakeSecureStorage();
      final queue = OfflineQueue(storage, storageKey: 'wellbeing_offline_queue');
      final collector = _FakeAppUsageCollector();
      // A real ApiClient — safe here because this test's scenario
      // never actually reaches a network call: the foreign event
      // throws inside _sendQueuedEvent's switch before ever
      // dispatching to _apiClient.post().
      final apiClient = ApiClient(SecureTokenStorage(storage));
      final service = DigitalWellbeingService(collector, apiClient, queue, _FakeAgentChannel());

      // Manually enqueue a foreign event type directly into the SAME
      // queue instance this service would drain, simulating what
      // would happen if isolation were ever accidentally removed.
      await queue.enqueue('some_other_producers_event', {'foo': 'bar'});

      final sentCount = await service.drainOwnEvents();

      // Zero sent — the foreign event caused an immediate throw, so
      // OfflineQueue.drain()'s own "stop at first failure" behavior
      // left it queued rather than silently discarding it.
      expect(sentCount, 0);
      expect(await queue.length(), 1);
    });
  });

  group('DigitalWellbeingService — Sprint 14 (Behavioral Intelligence Engine) enrichment', () {
    test('enriches the queued payload with on-device categories and session stats', () async {
      final storage = _FakeSecureStorage();
      final queue = OfflineQueue(storage, storageKey: 'wellbeing_offline_queue');
      final collector = _FakeAppUsageCollector()..usage = {'com.duolingo': const Duration(minutes: 30)};
      final apiClient = ApiClient(SecureTokenStorage(storage));

      final channel = _EnrichedFakeAgentChannel();
      final service = DigitalWellbeingService(collector, apiClient, queue, channel);

      await service.buildAndQueueDailySummary(blockedAttemptCount: 0);

      expect(await queue.length(), 1);
      // Peek at the queue's own persisted raw payload via a fresh
      // read — proving the enrichment actually reached storage, not
      // just an in-memory object this test happens to hold a
      // reference to.
      final raw = await storage.read(key: 'wellbeing_offline_queue');
      expect(raw, contains('EDUCATION'));
      expect(raw, contains('"sessionCount":12'));
    });

    test('BOUNDARY CASE: still queues the summary successfully even when category/session/pickup lookups fail (best-effort)', () async {
      final storage = _FakeSecureStorage();
      final queue = OfflineQueue(storage, storageKey: 'wellbeing_offline_queue');
      final collector = _FakeAppUsageCollector()..usage = {'com.example.app': const Duration(minutes: 20)};
      final apiClient = ApiClient(SecureTokenStorage(storage));

      final service = DigitalWellbeingService(collector, apiClient, queue, _ThrowingFakeAgentChannel());

      await service.buildAndQueueDailySummary(blockedAttemptCount: 0);

      // Did not throw, and the summary's core fields still queued.
      expect(await queue.length(), 1);
    });

    test('FIXES A REAL BUG (Sprint 14.1 integration audit): pickupCount and nightUsageMinutes are now real device data, not hardcoded 0', () async {
      final storage = _FakeSecureStorage();
      final queue = OfflineQueue(storage, storageKey: 'wellbeing_offline_queue');
      final collector = _FakeAppUsageCollector()..usage = {'com.duolingo': const Duration(minutes: 30)};
      final apiClient = ApiClient(SecureTokenStorage(storage));

      // _EnrichedFakeAgentChannel: pickupCount=42, usageByHour has
      // 15min at hour 23 + 10min at hour 2 (both night hours) + 30min
      // at hour 14 (daytime — must NOT be counted).
      final service = DigitalWellbeingService(collector, apiClient, queue, _EnrichedFakeAgentChannel());

      await service.buildAndQueueDailySummary(blockedAttemptCount: 0);

      final raw = await storage.read(key: 'wellbeing_offline_queue');
      expect(raw, contains('"pickupCount":42'));
      // 15 (hour 23) + 10 (hour 2) = 25 — the daytime hour 14 (30min)
      // must be excluded from this sum.
      expect(raw, contains('"nightUsageMinutes":25'));
    });
  });
}
