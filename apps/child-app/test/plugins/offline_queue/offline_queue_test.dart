import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:child_app/plugins/offline_queue/application/offline_queue.dart';

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
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('OfflineQueue', () {
    late OfflineQueue queue;

    setUp(() {
      queue = OfflineQueue(_FakeSecureStorage());
    });

    test('starts empty', () async {
      expect(await queue.length(), 0);
    });

    test('enqueue adds an event, readable via peekAll', () async {
      await queue.enqueue('heartbeat', {'batteryPercent': 80});

      final events = await queue.peekAll();
      expect(events, hasLength(1));
      expect(events.first.type, 'heartbeat');
      expect(events.first.payload['batteryPercent'], 80);
    });

    test('persists across separate reads (same underlying storage)', () async {
      final storage = _FakeSecureStorage();
      final queueA = OfflineQueue(storage);
      final queueB = OfflineQueue(storage);

      await queueA.enqueue('heartbeat', {'batteryPercent': 50});

      expect(await queueB.length(), 1);
    });

    test('drain sends every event and clears them on full success', () async {
      await queue.enqueue('heartbeat', {'n': 1});
      await queue.enqueue('heartbeat', {'n': 2});

      final sentPayloads = <int>[];
      final sentCount = await queue.drain((event) async {
        sentPayloads.add(event.payload['n'] as int);
      });

      expect(sentCount, 2);
      expect(sentPayloads, [1, 2]);
      expect(await queue.length(), 0);
    });

    test('drain stops at the first failure, leaving the rest queued', () async {
      await queue.enqueue('heartbeat', {'n': 1});
      await queue.enqueue('heartbeat', {'n': 2});
      await queue.enqueue('heartbeat', {'n': 3});

      final sentCount = await queue.drain((event) async {
        if (event.payload['n'] == 2) throw Exception('still offline');
      });

      expect(sentCount, 1); // only the first one succeeded before the failure
      expect(await queue.length(), 2); // events 2 and 3 remain queued
    });

    test('caps queue size, dropping the oldest events first', () async {
      for (var i = 0; i < 210; i++) {
        await queue.enqueue('heartbeat', {'n': i});
      }

      final events = await queue.peekAll();
      expect(events.length, 200);
      expect(events.first.payload['n'], 10); // the oldest 10 were dropped
      expect(events.last.payload['n'], 209);
    });

    test('clear empties the queue', () async {
      await queue.enqueue('heartbeat', {'n': 1});
      await queue.clear();
      expect(await queue.length(), 0);
    });
  });
}
