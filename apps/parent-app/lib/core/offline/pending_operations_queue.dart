import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class PendingOperation {
  const PendingOperation({required this.id, required this.type, required this.description, required this.payload, required this.queuedAt});

  final String id;
  final String type;
  final String description;
  final Map<String, dynamic> payload;
  final DateTime queuedAt;

  Map<String, dynamic> toJson() => {
        'id': id,
        'type': type,
        'description': description,
        'payload': payload,
        'queuedAt': queuedAt.toIso8601String(),
      };

  factory PendingOperation.fromJson(Map<String, dynamic> json) => PendingOperation(
        id: json['id'] as String,
        type: json['type'] as String,
        description: json['description'] as String,
        payload: (json['payload'] as Map).cast<String, dynamic>(),
        queuedAt: DateTime.parse(json['queuedAt'] as String),
      );
}

/// The "visible pending-operations queue" requirement from the review.
/// Mirrors `child-app`'s `OfflineQueue` design (persist, cap size, drain
/// oldest-first) — reimplemented here since these are separate Flutter
/// projects. Unlike `child-app`'s queue (heartbeats, invisible), this
/// one exists specifically so a parent can SEE what's waiting to sync.
class PendingOperationsQueue {
  PendingOperationsQueue(this._storage);

  final FlutterSecureStorage _storage;
  static const _storageKey = 'parent_pending_operations';
  static const _maxQueueSize = 100;

  Future<void> enqueue(String type, String description, Map<String, dynamic> payload) async {
    final operations = await _readAll();
    operations.add(PendingOperation(
      id: '${DateTime.now().microsecondsSinceEpoch}',
      type: type,
      description: description,
      payload: payload,
      queuedAt: DateTime.now(),
    ));

    final trimmed = operations.length > _maxQueueSize
        ? operations.sublist(operations.length - _maxQueueSize)
        : operations;

    await _writeAll(trimmed);
  }

  Future<List<PendingOperation>> peekAll() => _readAll();

  Future<int> length() async => (await _readAll()).length;

  Future<int> drain(Future<void> Function(PendingOperation operation) sender) async {
    final operations = await _readAll();
    var sentCount = 0;

    for (final operation in operations) {
      try {
        await sender(operation);
        sentCount++;
      } catch (_) {
        break;
      }
    }

    if (sentCount > 0) {
      await _writeAll(operations.sublist(sentCount));
    }

    return sentCount;
  }

  Future<void> clear() => _writeAll(const []);

  Future<List<PendingOperation>> _readAll() async {
    final raw = await _storage.read(key: _storageKey);
    if (raw == null) return [];
    try {
      final list = jsonDecode(raw) as List<dynamic>;
      return list.map((e) => PendingOperation.fromJson(e as Map<String, dynamic>)).toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> _writeAll(List<PendingOperation> operations) async {
    await _storage.write(key: _storageKey, value: jsonEncode(operations.map((e) => e.toJson()).toList()));
  }
}
