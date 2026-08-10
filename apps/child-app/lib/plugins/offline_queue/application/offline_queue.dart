import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class QueuedEvent {
  const QueuedEvent({required this.type, required this.payload, required this.queuedAt});

  final String type;
  final Map<String, dynamic> payload;
  final DateTime queuedAt;

  Map<String, dynamic> toJson() => {
        'type': type,
        'payload': payload,
        'queuedAt': queuedAt.toIso8601String(),
      };

  factory QueuedEvent.fromJson(Map<String, dynamic> json) => QueuedEvent(
        type: json['type'] as String,
        payload: (json['payload'] as Map).cast<String, dynamic>(),
        queuedAt: DateTime.parse(json['queuedAt'] as String),
      );
}

/// Sprint 7 \u2014 "Offline Queue" + "Runtime Event Queue" unified into one
/// concept (kept as a single class rather than two, since a duplicated
/// implementation of "persist events, replay on reconnect" would just be
/// the same mechanism twice with different labels). Persists via
/// `flutter_secure_storage` (already a dependency since Step 1) \u2014
/// no new package. Deliberately caps queue size so a device offline for
/// weeks doesn't grow this unbounded.
class OfflineQueue {
  OfflineQueue(this._storage, {String storageKey = _defaultStorageKey}) : _storageKey = storageKey;

  final FlutterSecureStorage _storage;
  final String _storageKey;
  static const _defaultStorageKey = 'cre_offline_queue';
  static const _maxQueueSize = 200;

  Future<void> enqueue(String type, Map<String, dynamic> payload) async {
    final events = await _readAll();
    events.add(QueuedEvent(type: type, payload: payload, queuedAt: DateTime.now()));

    // Drop the oldest events first if over capacity \u2014 recent events are
    // more actionable than very old ones for this product's purposes.
    final trimmed = events.length > _maxQueueSize
        ? events.sublist(events.length - _maxQueueSize)
        : events;

    await _writeAll(trimmed);
  }

  Future<List<QueuedEvent>> peekAll() => _readAll();

  Future<int> length() async => (await _readAll()).length;

  /// Attempts to send every queued event via [sender], removing each one
  /// only after a successful send. Stops at the first failure (assumes
  /// still offline) rather than attempting every remaining event and
  /// accumulating failures \u2014 the next scheduled drain retries from
  /// there instead.
  Future<int> drain(Future<void> Function(QueuedEvent event) sender) async {
    final events = await _readAll();
    var sentCount = 0;

    for (final event in events) {
      try {
        await sender(event);
        sentCount++;
      } catch (_) {
        break;
      }
    }

    if (sentCount > 0) {
      await _writeAll(events.sublist(sentCount));
    }

    return sentCount;
  }

  Future<void> clear() => _writeAll(const []);

  Future<List<QueuedEvent>> _readAll() async {
    final raw = await _storage.read(key: _storageKey);
    if (raw == null) return [];
    try {
      final list = jsonDecode(raw) as List<dynamic>;
      return list.map((e) => QueuedEvent.fromJson(e as Map<String, dynamic>)).toList();
    } catch (_) {
      return []; // corrupted queue \u2014 same "never crash on bad local data" discipline as PolicyCacheService
    }
  }

  Future<void> _writeAll(List<QueuedEvent> events) async {
    await _storage.write(
      key: _storageKey,
      value: jsonEncode(events.map((e) => e.toJson()).toList()),
    );
  }
}
