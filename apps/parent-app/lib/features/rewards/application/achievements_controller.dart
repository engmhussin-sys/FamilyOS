import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/reward_programs_repository.dart';
import '../domain/achievement.dart';
import '../domain/reward_program.dart';

/// One row of the parent's review queue: the achievement plus the program
/// it belongs to, joined CLIENT-SIDE because
/// `GET /reward-programs/achievements/pending` returns bare
/// `AchievementRequest` rows and the parent needs to read
/// «الآيات 1–5 من سورة الملك», not a UUID.
///
/// The join is a display concern and nothing more: the program list is
/// already fetched for the same screen, and a missing program simply leaves
/// [program] null rather than hiding the row (a pending decision must never
/// disappear because a lookup failed).
class PendingReviewItem {
  const PendingReviewItem({required this.achievement, this.program});

  final AchievementRequest achievement;
  final RewardProgram? program;

  String get targetSummaryAr => program?.targetSummaryAr ?? '';
}

class PendingAchievementsController extends StateNotifier<UiState<List<PendingReviewItem>>> {
  PendingAchievementsController(this._repository) : super(const UiState.loading()) {
    load();
  }

  final RewardProgramsRepository _repository;

  Future<void> load() async {
    state = const UiState.loading();
    try {
      final achievements = await _repository.listPendingAchievements();
      if (achievements.isEmpty) {
        state = const UiState<List<PendingReviewItem>>.empty();
        return;
      }
      // Best-effort enrichment: the queue renders with or without it.
      Map<String, RewardProgram> byId = const {};
      try {
        final programs = await _repository.listPrograms();
        byId = {for (final p in programs) p.id: p};
      } on ApiFailure {
        byId = const {};
      }
      state = UiState<List<PendingReviewItem>>.data([
        for (final a in achievements)
          PendingReviewItem(achievement: a, program: byId[a.programId]),
      ]);
    } on ApiFailure catch (failure) {
      state = UiState<List<PendingReviewItem>>.error(failure);
    }
  }
}

/// The review screen: the append-only attempt log plus the decision.
class AchievementReviewState {
  const AchievementReviewState({
    this.attempts = const UiState<List<VerificationAttempt>>.loading(),
    this.evidence = const [],
    this.busy = false,
    this.decisionFailure,
    this.decided,
  });

  final UiState<List<VerificationAttempt>> attempts;

  /// B5: uploaded evidence METADATA, arriving in the same call as the
  /// attempts. Ids, types and sizes only — never a storage key.
  final List<EvidenceRef> evidence;
  final bool busy;
  final ApiFailure? decisionFailure;

  /// The achievement as it came back from approve/reject — non-null means
  /// the decision landed and the screen may pop.
  final AchievementRequest? decided;

  bool get isDecided => decided != null;

  AchievementReviewState copyWith({
    UiState<List<VerificationAttempt>>? attempts,
    List<EvidenceRef>? evidence,
    bool? busy,
    ApiFailure? decisionFailure,
    bool clearFailure = false,
    AchievementRequest? decided,
  }) =>
      AchievementReviewState(
        attempts: attempts ?? this.attempts,
        evidence: evidence ?? this.evidence,
        busy: busy ?? this.busy,
        decisionFailure: clearFailure ? null : (decisionFailure ?? this.decisionFailure),
        decided: decided ?? this.decided,
      );
}

class AchievementReviewController extends StateNotifier<AchievementReviewState> {
  AchievementReviewController(this._repository, this.achievementId)
      : super(const AchievementReviewState()) {
    load();
  }

  final RewardProgramsRepository _repository;
  final String achievementId;

  /// B5 CHANGED THE SHAPE OF THIS CALL, for the better: one request now
  /// returns the attempt log AND the evidence metadata, so a parent deciding
  /// on a recitation does not pay two round trips on a mobile connection.
  Future<void> load() async {
    state = state.copyWith(attempts: const UiState<List<VerificationAttempt>>.loading());
    try {
      final detail = await _repository.getAchievementDetail(achievementId);
      state = state.copyWith(
        attempts: UiState.fromList(detail.attempts),
        evidence: detail.evidence,
      );
    } on ApiFailure catch (failure) {
      state = state.copyWith(attempts: UiState<List<VerificationAttempt>>.error(failure));
    }
  }

  Future<void> approve({String? note}) => _decide(approve: true, note: note);

  /// REJECT, in the product's own voice. The server writes a
  /// `PARENT_REJECTED` attempt row and emits `ACHIEVEMENT_REJECTED`; it
  /// grants nothing and it closes no door — the child can attempt again
  /// tomorrow under the same program. The UI copy says exactly that and
  /// never says «فشلت».
  Future<void> reject({String? note}) => _decide(approve: false, note: note);

  Future<void> _decide({required bool approve, String? note}) async {
    if (state.busy) return;
    state = state.copyWith(busy: true, clearFailure: true);
    try {
      final decided = approve
          ? await _repository.approve(achievementId, note: note)
          : await _repository.reject(achievementId, note: note);
      state = state.copyWith(busy: false, decided: decided);
    } on ApiFailure catch (failure) {
      state = state.copyWith(busy: false, decisionFailure: failure);
    }
  }

  void clearFailure() => state = state.copyWith(clearFailure: true);
}
