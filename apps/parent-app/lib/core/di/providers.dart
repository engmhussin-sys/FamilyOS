import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../auth/session_expired_notifier.dart';
import '../network/api_client.dart';
import '../notifications/push_registration_service.dart';
import '../offline/pending_operations_queue.dart';
import '../storage/secure_session_storage.dart';
import '../../features/authentication/api/auth_api.dart';
import '../../features/authentication/application/auth_controller.dart';
import '../../features/family/api/family_api.dart';
import '../../features/pairing/api/pairing_api.dart';
import '../../features/dashboard/api/dashboard_api.dart';
import '../../features/notifications/api/notifications_api.dart';
import '../../features/settings/api/settings_api.dart';
import '../../features/life_intelligence/api/life_intelligence_api.dart';
import '../../features/billing/api/billing_api.dart';
import '../../features/support/api/support_api.dart';
import '../../features/family/api/consent_api.dart';
import '../../features/settings/api/account_api.dart';
import '../../features/billing/api/campaign_api.dart';
import '../../features/rewards/api/reward_programs_api.dart';
import '../../features/rewards/application/achievements_controller.dart';
import '../../features/rewards/application/catalogue_controller.dart';
import '../../features/rewards/application/child_rewards_controller.dart';
import '../../features/rewards/application/fulfilments_controller.dart';
import '../../features/rewards/application/program_draft_controller.dart';
import '../../features/rewards/application/programs_controller.dart';
import '../../features/rewards/application/suggestions_controller.dart';
import '../../features/rewards/data/reward_programs_repository.dart';
import '../../features/rewards/domain/program_catalogue.dart';
import '../../features/rewards/domain/reward_program.dart';
import '../state/ui_state.dart';

final secureStorageProvider = Provider<FlutterSecureStorage>((ref) => const FlutterSecureStorage());

final sessionStorageProvider = Provider<SecureSessionStorage>(
  (ref) => SecureSessionStorage(ref.watch(secureStorageProvider)),
);

final pendingOperationsQueueProvider = Provider<PendingOperationsQueue>(
  (ref) => PendingOperationsQueue(ref.watch(secureStorageProvider)),
);

final apiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(
    ref.watch(sessionStorageProvider),
    onSessionExpired: () => ref.read(sessionExpiredProvider.notifier).state++,
  ),
);

final authApiProvider = Provider<AuthApi>((ref) => AuthApi(ref.watch(apiClientProvider)));
final familyApiProvider = Provider<FamilyApi>((ref) => FamilyApi(ref.watch(apiClientProvider)));
final pairingApiProvider = Provider<PairingApi>((ref) => PairingApi(ref.watch(apiClientProvider)));
final dashboardApiProvider = Provider<DashboardApi>((ref) => DashboardApi(ref.watch(apiClientProvider)));
final notificationsApiProvider = Provider<NotificationsApi>(
  (ref) => NotificationsApi(ref.watch(apiClientProvider), ref.watch(pendingOperationsQueueProvider)),
);
final settingsApiProvider = Provider<SettingsApi>((ref) => SettingsApi(ref.watch(apiClientProvider)));
final lifeIntelligenceApiProvider = Provider<LifeIntelligenceApi>((ref) => LifeIntelligenceApi(ref.watch(apiClientProvider)));
final billingApiProvider = Provider<BillingApi>((ref) => BillingApi(ref.watch(apiClientProvider)));
final pushRegistrationServiceProvider = Provider<PushRegistrationService>((ref) => PushRegistrationService(ref.watch(pairingApiProvider)));
final supportApiProvider = Provider<SupportApi>((ref) => SupportApi(ref.watch(apiClientProvider)));
final consentApiProvider = Provider<ConsentApi>((ref) => ConsentApi(ref.watch(apiClientProvider)));
final accountApiProvider = Provider<AccountApi>((ref) => AccountApi(ref.watch(apiClientProvider)));
final campaignApiProvider = Provider<CampaignApi>((ref) => CampaignApi(ref.watch(apiClientProvider)));

final authControllerProvider = StateNotifierProvider<AuthController, AuthState>(
  (ref) => AuthController(ref.watch(authApiProvider), ref.watch(sessionStorageProvider)),
);

// ---------------------------------------------------------------------------
// B6 — THE F4 SMART REWARD ENGINE SURFACE
//
// Wired into the EXISTING container, on the EXISTING `apiClientProvider`.
// No second HTTP client, no second auth path, no second refresh loop: the
// 17 parent endpoints below inherit the coordinated-single-refresh-on-401
// and the B3 error-envelope parsing that `ApiClient` already owns.
// ---------------------------------------------------------------------------

final rewardProgramsApiProvider = Provider<RewardProgramsApi>(
  (ref) => RewardProgramsApi(ref.watch(apiClientProvider)),
);

final rewardProgramsRepositoryProvider = Provider<RewardProgramsRepository>(
  (ref) => RewardProgramsRepository(
    ref.watch(rewardProgramsApiProvider),
    // Reused, not rebuilt: the points balance already has a client.
    ref.watch(lifeIntelligenceApiProvider),
  ),
);

/// Reference data for the whole create flow, fetched once per app session.
final catalogueControllerProvider =
    StateNotifierProvider<CatalogueController, UiState<ProgramCatalogue>>(
  (ref) => CatalogueController(ref.watch(rewardProgramsRepositoryProvider)),
);

/// The 114 surahs. `autoDispose` is deliberately NOT used: this is
/// immutable reference data identical for every family, so re-fetching it
/// each time the wizard reaches step 3 would be pure waste.
final surahControllerProvider =
    StateNotifierProvider<SurahController, UiState<List<QuranSurah>>>(
  (ref) => SurahController(ref.watch(rewardProgramsRepositoryProvider)),
);

/// The create wizard. `autoDispose` so leaving the flow really does discard
/// the draft — a half-finished goal must not silently reappear a week later.
final programWizardControllerProvider =
    StateNotifierProvider.autoDispose<ProgramWizardController, ProgramWizardState>(
  (ref) => ProgramWizardController(ref.watch(rewardProgramsRepositoryProvider)),
);

/// The assigned-goals list. Family-wide when the argument is null.
final programsControllerProvider = StateNotifierProvider.autoDispose
    .family<ProgramsController, UiState<List<RewardProgram>>, String?>(
  (ref, childId) => ProgramsController(ref.watch(rewardProgramsRepositoryProvider), childId),
);

final programDetailControllerProvider = StateNotifierProvider.autoDispose
    .family<ProgramDetailController, ProgramDetailState, String>(
  (ref, programId) => ProgramDetailController(ref.watch(rewardProgramsRepositoryProvider), programId),
);

/// The REAL approval queue — SUBMITTED + PENDING_PARENT achievements.
/// Not to be confused with `pending_approvals_screen.dart`, which lists
/// pending MESSAGES from a different module entirely (audit P12).
final pendingAchievementsControllerProvider = StateNotifierProvider.autoDispose<
    PendingAchievementsController, UiState<List<PendingReviewItem>>>(
  (ref) => PendingAchievementsController(ref.watch(rewardProgramsRepositoryProvider)),
);

final achievementReviewControllerProvider = StateNotifierProvider.autoDispose
    .family<AchievementReviewController, AchievementReviewState, String>(
  (ref, achievementId) =>
      AchievementReviewController(ref.watch(rewardProgramsRepositoryProvider), achievementId),
);

final fulfilmentsControllerProvider =
    StateNotifierProvider.autoDispose<FulfilmentsController, FulfilmentsState>(
  (ref) => FulfilmentsController(ref.watch(rewardProgramsRepositoryProvider)),
);

final childRewardsControllerProvider = StateNotifierProvider.autoDispose
    .family<ChildRewardsController, ChildRewardsState, String>(
  (ref, childId) => ChildRewardsController(ref.watch(rewardProgramsRepositoryProvider), childId),
);

final suggestionsControllerProvider = StateNotifierProvider.autoDispose
    .family<SuggestionsController, SuggestionsState, String>(
  (ref, childId) => SuggestionsController(ref.watch(rewardProgramsRepositoryProvider), childId),
);

/// The family's children, for the wizard's first step and every
/// child-scoped screen. Reuses `GET /children` through the existing
/// DashboardApi rather than adding a second caller of the same route.
final familyChildrenProvider = FutureProvider.autoDispose<List<dynamic>>(
  (ref) => ref.watch(dashboardApiProvider).getChildren(),
);
