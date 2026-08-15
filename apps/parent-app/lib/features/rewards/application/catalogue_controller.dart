import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/reward_programs_repository.dart';
import '../domain/program_catalogue.dart';

/// APPLICATION LAYER — orchestration only.
///
/// A controller in this feature may: call a repository, hold a [UiState],
/// and sequence calls. It may NOT: compute a reward, decide eligibility,
/// decide whether verification passed, or derive a streak. Every one of
/// those is a server decision (`verification-strategies.ts`,
/// `program-rules.ts`, `streak-multiplier.ts`) and the client's job is to
/// display the answer, not to hold an opinion about it.

class CatalogueController extends StateNotifier<UiState<ProgramCatalogue>> {
  CatalogueController(this._repository) : super(const UiState.loading()) {
    load();
  }

  final RewardProgramsRepository _repository;

  Future<void> load() async {
    state = const UiState.loading();
    try {
      final catalogue = await _repository.loadCatalogue();
      state = catalogue.isEmpty
          ? const UiState<ProgramCatalogue>.empty()
          : UiState<ProgramCatalogue>.data(catalogue);
    } on ApiFailure catch (failure) {
      state = UiState<ProgramCatalogue>.error(failure);
    }
  }
}

/// The 114 surahs, loaded ONCE per app session.
///
/// Kept in its own controller rather than folded into the catalogue for a
/// concrete reason: it is 114 rows of reference data that only the Quran
/// branch of the wizard needs, and a parent creating a SPORT program should
/// not pay for it. It is also identical for every family, which is why the
/// `keepAlive` provider below never refetches it.
class SurahController extends StateNotifier<UiState<List<QuranSurah>>> {
  SurahController(this._repository) : super(const UiState.loading());

  final RewardProgramsRepository _repository;
  bool _loaded = false;

  /// Idempotent: the wizard calls this every time step 3 is reached and
  /// only the first call does any work.
  Future<void> ensureLoaded() async {
    if (_loaded && state.hasData) return;
    state = const UiState.loading();
    try {
      final surahs = await _repository.loadSurahs();
      _loaded = surahs.isNotEmpty;
      state = UiState.fromList(surahs);
    } on ApiFailure catch (failure) {
      state = UiState<List<QuranSurah>>.error(failure);
    }
  }

  Future<void> reload() async {
    _loaded = false;
    await ensureLoaded();
  }
}
