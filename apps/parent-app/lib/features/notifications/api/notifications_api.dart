import '../../../core/network/api_client.dart';

class NotificationsApi {
  NotificationsApi(this._client);

  final ApiClient _client;

  Future<List<dynamic>> list({bool unreadOnly = false}) async {
    final result = await _client.get('/notifications', queryParameters: {'unreadOnly': unreadOnly});
    return result['data'] as List<dynamic>;
  }

  Future<void> markAsRead(String id) => _client.patch('/notifications/$id/read');

  Future<void> markAllAsRead() => _client.post('/notifications/read-all');
}
