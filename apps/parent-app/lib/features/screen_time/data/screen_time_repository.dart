import '../../../core/errors/api_failure.dart';
import '../../../core/network/api_exception.dart';
import '../api/screen_time_api.dart';
import '../domain/app_block_rule.dart';
import '../domain/screen_time_policy.dart';

/// THE DATA LAYER BOUNDARY for the screen-time surface.
///
/// Two jobs, both of which stop something leaking upward, and both copied from
/// `RewardProgramsRepository` because that is this app's shape:
///   1. JSON → domain types. Above this line nothing touches a
///      `Map<String, dynamic>` that came off a socket.
///   2. [ApiException] → [ApiFailure]. Above this line nothing imports the
///      network layer, so no controller and no widget can depend on Dio or on
///      the transport's error shape — which is what makes «no `e.toString()`
///      ever reaches a parent» a property of the code rather than a habit.
///
/// It holds no state and caches nothing.
class ScreenTimeRepository {
  ScreenTimeRepository(this._api);

  final ScreenTimeApi _api;

  // --- policy --------------------------------------------------------------

  /// `null` when this child has no policy row at all — a real answer, not a
  /// failure, and the one the empty state is written for.
  Future<ScreenTimePolicy?> getPolicy(String childId) =>
      _guard(() async => ScreenTimePolicy.fromJson(await _api.getPolicy(childId)));

  Future<EffectiveScreenTimePolicy> getEffectivePolicy(String childId) => _guard(
        () async => EffectiveScreenTimePolicy.fromJson(
          await _api.getEffectivePolicy(childId),
        ),
      );

  /// THE ONE PLACE THE `SetScreenTimePolicyDto` BODY IS BUILT.
  ///
  /// Every field is `@IsOptional()`, and an ABSENT key and a `null` value are
  /// not the same thing to `class-validator`: `@Matches` on an explicit `null`
  /// fails, while an absent key is skipped. So a cleared bedtime is OMITTED,
  /// never sent as `null` or `""` — which is also what makes clearing it work,
  /// since `setPolicy` writes a NEW row from exactly what arrives.
  ///
  /// `weekdaySchedule` is deliberately NOT sent. This app has no editor for it
  /// (see `ScreenTimePolicy.hasWeekdaySchedule`), and sending back a shape this
  /// client never parsed would be inventing a value; omitting it is honest, and
  /// the editor screen warns the parent that a save drops existing overrides
  /// because the server REPLACES the row rather than merging it.
  Future<ScreenTimePolicy?> setPolicy(
    String childId, {
    int? dailyLimitMinutes,
    String? bedtimeStart,
    String? bedtimeEnd,
    bool? focusModeEnabled,
  }) =>
      _guard(() async {
        final body = <String, dynamic>{
          if (dailyLimitMinutes != null) 'dailyLimitMinutes': dailyLimitMinutes,
          if (bedtimeStart != null && bedtimeStart.trim().isNotEmpty)
            'bedtimeStart': bedtimeStart.trim(),
          if (bedtimeEnd != null && bedtimeEnd.trim().isNotEmpty)
            'bedtimeEnd': bedtimeEnd.trim(),
          if (focusModeEnabled != null) 'focusModeEnabled': focusModeEnabled,
        };
        return ScreenTimePolicy.fromJson(await _api.setPolicy(childId, body));
      });

  // --- app block rules -----------------------------------------------------

  Future<List<AppBlockRule>> listAppBlockRules(String childId) => _guard(() async {
        final rows = await _api.listAppBlockRules(childId);
        return rows.whereType<Map<String, dynamic>>().map(AppBlockRule.fromJson).toList();
      });

  /// `packageName` and `category` are mutually exclusive — the SERVICE, not
  /// just the DTO, refuses both-or-neither. This signature cannot express the
  /// illegal combination twice over: the caller supplies one named argument.
  Future<AppBlockRule> blockPackage(
    String childId, {
    required String packageName,
    String ruleType = AppRuleTypes.block,
    int? limitMinutes,
  }) =>
      _guard(() async => AppBlockRule.fromJson(await _api.createAppBlockRule(childId, {
            'packageName': packageName,
            'ruleType': ruleType,
            if (limitMinutes != null) 'limitMinutes': limitMinutes,
          })));

  Future<AppBlockRule> blockCategory(
    String childId, {
    required String category,
    String ruleType = AppRuleTypes.block,
    int? limitMinutes,
  }) =>
      _guard(() async => AppBlockRule.fromJson(await _api.createAppBlockRule(childId, {
            'category': category,
            'ruleType': ruleType,
            if (limitMinutes != null) 'limitMinutes': limitMinutes,
          })));

  /// DEACTIVATE, not delete — see [ScreenTimeApi.deactivateAppBlockRule]. The
  /// name is the contract, so no caller can write «delete» in a confirmation
  /// dialog and be accidentally right.
  Future<void> deactivateAppBlockRule(String childId, String ruleId) =>
      _guard(() => _api.deactivateAppBlockRule(childId, ruleId));

  // --- app catalogue -------------------------------------------------------

  /// The apps a device has actually reported. An EMPTY list is a legitimate,
  /// common answer — no device paired yet, or paired and not yet synced — and
  /// the picker says which, in Arabic, instead of showing an empty sheet.
  Future<List<AppCatalogEntry>> listChildApps(String childId) => _guard(() async {
        final body = await _api.listChildApps(childId);
        final items = body['items'];
        if (items is! List) return const <AppCatalogEntry>[];
        return items
            .whereType<Map<String, dynamic>>()
            .map(AppCatalogEntry.fromJson)
            .where((entry) => entry.packageName.isNotEmpty)
            .toList();
      });

  /// The ONE place [ApiException] is converted, exactly as
  /// `RewardProgramsRepository._guard` is.
  Future<T> _guard<T>(Future<T> Function() call) async {
    try {
      return await call();
    } on ApiException catch (e) {
      throw ApiFailure.from(e);
    }
  }
}
