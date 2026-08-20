import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/network/api_client.dart';
import 'package:child_app/features/family_growth/api/family_growth_api.dart';

/// A REGRESSION GUARD FOR A DEFECT THAT WAS GREEN BECAUSE IT WAS SWALLOWED.
///
/// `generateSmartTasks()` was `_client.post(...)` followed by
/// `result['data'] as List`. `ApiClient.post` casts the response body to a
/// `Map<String, dynamic>`, but `POST /life-intelligence/self/smart-tasks/
/// generate` returns a bare JSON **array**, so the cast threw a `TypeError`
/// on every call — before `['data']`, which does not exist on that route
/// either, was ever reached. The one caller wrapped it in a best-effort
/// `catch (_)`, so nothing failed loudly and the smart-task cards simply
/// never appeared on any device.
///
/// This test would have failed on the old code with a `TypeError`, which is
/// the only reason it is worth having.
class _ArrayReturningClient implements ApiClient {
  _ArrayReturningClient(this.response);

  final Object response;
  final List<String> postListPaths = [];
  final List<String> postPaths = [];

  @override
  Future<List<dynamic>> postList(
    String path, {
    Map<String, dynamic>? body,
    bool skipAuth = false,
  }) async {
    postListPaths.add(path);
    return response as List<dynamic>;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path, {
    Map<String, dynamic>? body,
    bool skipAuth = false,
  }) async {
    postPaths.add(path);
    // The shape this route actually returns. Kept here on purpose: if a
    // future change routes `generateSmartTasks` back through `post`, this
    // cast reproduces the original crash rather than hiding it.
    return response as Map<String, dynamic>;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('generateSmartTasks — response shape', () {
    test('reads the bare array the endpoint actually returns', () async {
      final client = _ArrayReturningClient([
        {'id': 't1', 'status': 'SUGGESTED'},
        {'id': 't2', 'status': 'ACCEPTED'},
      ]);
      final api = FamilyGrowthApi(client);

      final tasks = await api.generateSmartTasks();

      expect(tasks, hasLength(2));
      expect((tasks.first as Map<String, dynamic>)['id'], 't1');
    });

    test('goes through postList, NOT post — the Map-casting sibling', () async {
      final client = _ArrayReturningClient(const <dynamic>[]);
      final api = FamilyGrowthApi(client);

      await api.generateSmartTasks();

      expect(client.postListPaths, ['/life-intelligence/self/smart-tasks/generate']);
      expect(
        client.postPaths,
        isEmpty,
        reason: 'post() casts to Map and this route returns an array',
      );
    });

    test('an empty day is an empty list, not a failure', () async {
      final api = FamilyGrowthApi(_ArrayReturningClient(const <dynamic>[]));

      expect(await api.generateSmartTasks(), isEmpty);
    });
  });
}
