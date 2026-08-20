import '../../../core/errors/api_failure.dart';
import '../../../core/network/api_exception.dart';
import '../api/catalogue_api.dart';
import '../domain/catalogue_domain.dart';

/// JSON → domain, and [ApiException] → [ApiFailure]. The same boundary
/// `ChildCoachRepository` and `ChildAchievementsRepository` draw: above this
/// line nothing imports Dio and nothing loses `messageAr`.
class ChildCatalogueRepository {
  ChildCatalogueRepository(this._api);

  final ChildCatalogueApi _api;

  /// Unwraps `{domains: [...]}` and DROPS any row with no `code`. A chip with
  /// no code cannot be matched against a goal's category and cannot be
  /// un-selected by matching either, so it would be a dead tap target on a
  /// child's screen; omitting one row is better than rendering a broken one.
  ///
  /// A malformed body (no `domains` array at all) yields an empty list rather
  /// than an exception — the chooser's fallback for "no catalogue" is the
  /// same one it uses for a failed call, and it is a good one: the domains of
  /// today's actual goals.
  Future<List<CatalogueDomainRow>> domains() async {
    try {
      final body = await _api.domains();
      final rows = body['domains'];
      if (rows is! List) return const <CatalogueDomainRow>[];
      return rows
          .whereType<Map<String, dynamic>>()
          .map(CatalogueDomainRow.fromJson)
          .where((row) => row.code.isNotEmpty)
          .toList(growable: false);
    } on ApiException catch (e) {
      throw ApiFailure.from(e);
    }
  }
}
