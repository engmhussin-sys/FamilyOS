import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../../screen_time/data/screen_time_repository.dart';
import '../data/reward_programs_repository.dart';
import '../domain/achievement.dart';
import '../domain/fulfilment.dart';

/// What one child has EARNED, assembled from four real endpoints.
class ChildRewardsSnapshot {
  const ChildRewardsSnapshot({
    required this.account,
    required this.grants,
    required this.fulfilments,
    this.achievements = const [],
    this.streaks = const {},
    this.bonusMinutes,
    this.activeGrantIds,
  });

  /// From the pre-existing ledger endpoint. `xp` IS the product's «نقطة»
  /// (`REWARD_TYPE_TO_LEDGER: POINTS -> XP`) — one number, not two.
  final RewardsAccount? account;

  final List<ScreenTimeGrant> grants;

  /// Every fulfilment row this child produced. A fulfilment only exists
  /// because an achievement was VERIFIED, which is what makes this list a
  /// truthful "completed goals" record even though no
  /// `GET /achievements?status=VERIFIED` route exists yet.
  final List<RewardFulfilment> fulfilments;

  /// B5: the child's full achievement history, from the parent route that
  /// did not exist when B6's first pass was written. THIS is the truthful
  /// "completed goals" source — the earlier version had to infer it from
  /// fulfilment rows, which only exist for fulfillable reward types.
  final List<AchievementRequest> achievements;

  /// B5: the same five buckets the child sees.
  final Map<String, int> streaks;

  /// THE SERVER'S NUMBER, NOT A SUM OF THE LIST ABOVE.
  ///
  /// `GET …/screen-time-policy/effective` computes it in
  /// `ScreenTimeService.getEffectivePolicy` from grants the database filtered
  /// on `revokedAt: null, expiresAt: { gt: now }` at the SERVER's `now`. This
  /// screen used to re-sum [grants] against `DateTime.now()` on the handset,
  /// which is a second implementation of the same rule running on a different
  /// clock: a skewed phone, or an expiry crossing while the page was open, and
  /// the Rewards tab said «٤٥ دقيقة إضافية» while the Screen-Time tab and the
  /// child's own screen said «١٥». One question, one answer, from the one
  /// place entitled to give it.
  ///
  /// `null` means THE CALL FAILED — not «zero». The two are different
  /// sentences and the screen says so rather than rendering an invented zero.
  final int? bonusMinutes;

  /// The ids the server currently counts as active, taken from the same
  /// response's `bonusGrants`. It is what decides whether a row in [grants]
  /// (which is the FULL history — revoked and expired rows included) is drawn
  /// as live. Derived on the server, never from the device clock.
  ///
  /// `null` for the same reason [bonusMinutes] is: the call failed and the
  /// rows are drawn without a status they cannot honestly claim.
  final Set<String>? activeGrantIds;

  List<AchievementRequest> get verifiedAchievements =>
      achievements.where((a) => a.isVerified).toList();

  /// Revocation is a stored server fact (`revokedAt`), so it is answerable
  /// without the effective-policy call. Everything else defers to the server's
  /// active set.
  GrantStanding standingOf(ScreenTimeGrant grant) {
    if (grant.isRevoked) return GrantStanding.revoked;
    final active = activeGrantIds;
    if (active == null) return GrantStanding.unknown;
    return active.contains(grant.id) ? GrantStanding.active : GrantStanding.ended;
  }

  bool get isEmpty =>
      account == null && grants.isEmpty && fulfilments.isEmpty && achievements.isEmpty;
}

class ChildRewardsState {
  const ChildRewardsState({
    this.snapshot = const UiState<ChildRewardsSnapshot>.loading(),
    this.busyGrantId,
    this.actionFailure,
    this.revoked = false,
  });

  final UiState<ChildRewardsSnapshot> snapshot;
  final String? busyGrantId;
  final ApiFailure? actionFailure;
  final bool revoked;

  ChildRewardsState copyWith({
    UiState<ChildRewardsSnapshot>? snapshot,
    String? busyGrantId,
    bool clearBusy = false,
    ApiFailure? actionFailure,
    bool clearFailure = false,
    bool? revoked,
  }) =>
      ChildRewardsState(
        snapshot: snapshot ?? this.snapshot,
        busyGrantId: clearBusy ? null : (busyGrantId ?? this.busyGrantId),
        actionFailure: clearFailure ? null : (actionFailure ?? this.actionFailure),
        revoked: revoked ?? this.revoked,
      );
}

/// PARTIAL-FAILURE DISCIPLINE, the same one `dashboard_home_screen.dart`
/// already applies: the sources are fetched independently and one failing does
/// not blank the others. Only a failure of the ledger, the grants, the
/// fulfilments AND the achievements together is an error state — anything else
/// is data with a hole in it, which is the truthful rendering.
class ChildRewardsController extends StateNotifier<ChildRewardsState> {
  ChildRewardsController(this._repository, this._screenTime, this.childId)
      : super(const ChildRewardsState()) {
    load();
  }

  final RewardProgramsRepository _repository;

  /// READ, NOT RE-DERIVED. The bonus-minutes total and the set of grants that
  /// are live right now both come from `…/screen-time-policy/effective` — the
  /// same route `screen_time_overview_screen.dart` renders — so the two parent
  /// tabs cannot disagree with each other or with the child's own screen.
  final ScreenTimeRepository _screenTime;

  final String childId;

  Future<void> load() async {
    state = state.copyWith(
      snapshot: const UiState<ChildRewardsSnapshot>.loading(),
      clearFailure: true,
    );

    RewardsAccount? account;
    ApiFailure? accountFailure;
    try {
      account = await _repository.loadAccount(childId);
    } on ApiFailure catch (f) {
      accountFailure = f;
    }

    List<ScreenTimeGrant> grants = const [];
    ApiFailure? grantsFailure;
    try {
      grants = await _repository.listScreenTimeGrants(childId);
    } on ApiFailure catch (f) {
      grantsFailure = f;
    }

    List<RewardFulfilment> fulfilments = const [];
    ApiFailure? fulfilmentsFailure;
    try {
      final all = await _repository.listFulfilments();
      fulfilments = all.where((f) => f.childId == childId).toList();
    } on ApiFailure catch (f) {
      fulfilmentsFailure = f;
    }

    List<AchievementRequest> achievements = const [];
    ApiFailure? achievementsFailure;
    try {
      achievements = await _repository.listAchievementsForChild(childId);
    } on ApiFailure catch (f) {
      achievementsFailure = f;
    }

    Map<String, int> streaks = const {};
    try {
      streaks = await _repository.getStreaks(childId);
    } on ApiFailure catch (_) {
      // Best-effort; streaks are a nice-to-have next to the ledger.
    }

    // The server's bonus total and its active set. A failure here leaves both
    // null — «we could not read it», which the screen states — rather than
    // falling back to a local sum, which is the defect this call replaced.
    int? bonusMinutes;
    Set<String>? activeGrantIds;
    try {
      final effective = await _screenTime.getEffectivePolicy(childId);
      bonusMinutes = effective.bonusMinutes;
      activeGrantIds = {for (final g in effective.bonusGrants) g.id};
    } on ApiFailure catch (_) {
      // Deliberately not promoted to an error state: the ledger, the grant
      // history and the completed goals on this screen are all still true.
    }

    if (accountFailure != null &&
        grantsFailure != null &&
        fulfilmentsFailure != null &&
        achievementsFailure != null) {
      state = state.copyWith(snapshot: UiState<ChildRewardsSnapshot>.error(accountFailure));
      return;
    }

    final snapshot = ChildRewardsSnapshot(
      account: account,
      grants: grants,
      fulfilments: fulfilments,
      achievements: achievements,
      streaks: streaks,
      bonusMinutes: bonusMinutes,
      activeGrantIds: activeGrantIds,
    );
    state = state.copyWith(
      snapshot: snapshot.isEmpty
          ? const UiState<ChildRewardsSnapshot>.empty()
          : UiState<ChildRewardsSnapshot>.data(snapshot),
    );
  }

  /// Revoking a screen-time grant does NOT touch the ledger row that paid
  /// for it — the reward was earned and stays earned. It withdraws the
  /// bonus minutes only, which is why the confirmation copy says «سحب
  /// المنحة» and not «إلغاء المكافأة».
  Future<void> revokeGrant(String grantId) async {
    if (state.busyGrantId != null) return;
    state = state.copyWith(busyGrantId: grantId, clearFailure: true);
    try {
      await _repository.revokeScreenTimeGrant(grantId);
      state = state.copyWith(clearBusy: true, revoked: true);
      await load();
    } on ApiFailure catch (failure) {
      state = state.copyWith(clearBusy: true, actionFailure: failure);
    }
  }

  void clearFailure() => state = state.copyWith(clearFailure: true);
}
