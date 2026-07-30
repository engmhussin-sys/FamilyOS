import '../../../core/network/api_client.dart';
import '../../../core/offline/pending_operations_queue.dart';

/// Read (`list`) is never queued — there's nothing to retry for a read
/// that failed; the screen's own error+retry state (Production
/// Readiness Review fix) already covers that. Only the two WRITE
/// actions (mark-as-read, mark-all-as-read) enqueue on failure, per the
/// review's "visible pending-operations queue" requirement — a
/// mark-as-read tap while offline is not silently lost.
class NotificationsApi {
  NotificationsApi(this._client, this._pendingQueue);

  final ApiClient _client;
  final PendingOperationsQueue _pendingQueue;

  Future<List<dynamic>> list({bool unreadOnly = false}) async {
    final result = await _client.get('/notifications', queryParameters: {'unreadOnly': unreadOnly});
    return result['data'] as List<dynamic>;
  }

  Future<void> markAsRead(String id) async {
    try {
      await _client.patch('/notifications/$id/read');
    } catch (e) {
      await _pendingQueue.enqueue('markNotificationRead', 'Mark notification as read', {'id': id});
      rethrow;
    }
  }

  Future<void> markAllAsRead() async {
    try {
      await _client.post('/notifications/read-all');
    } catch (e) {
      await _pendingQueue.enqueue('markAllNotificationsRead', 'Mark all notifications as read', {});
      rethrow;
    }
  }

  /// Called by the drain loop (wired from `main.dart` on reconnect) —
  /// replays a single queued operation against the real API.
  Future<void> replay(PendingOperation operation) async {
    switch (operation.type) {
      case 'markNotificationRead':
        await _client.patch('/notifications/${operation.payload['id']}/read');
        break;
      case 'markAllNotificationsRead':
        await _client.post('/notifications/read-all');
        break;
      default:
        throw StateError('Unknown pending operation type: ${operation.type}');
    }
  }
}
