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
import '../../features/life_intelligence/data/life_intelligence_repository.dart';
import '../../features/billing/api/billing_api.dart';
import '../../features/billing/application/subscription_purchase_coordinator.dart';
import '../../features/billing/domain/store_billing_client.dart';
import '../../features/support/api/support_api.dart';
import '../../features/support/data/support_repository.dart';
import '../../features/family/api/consent_api.dart';
import '../../features/family/application/child_detail_controller.dart';
import '../../features/family/data/child_profile_repository.dart';
import '../../features/safety/application/safety_controller.dart';
import '../../features/safety/data/safety_repository.dart';
import '../../features/settings/api/account_api.dart';
import '../../features/settings/data/account_repository.dart';
import '../../features/billing/api/campaign_api.dart';
import '../../features/billing/data/campaign_repository.dart';
import '../../features/rewards/api/reward_programs_api.dart';
import '../../features/rewards/application/achievements_controller.dart';
import '../../features/rewards/application/catalogue_controller.dart';
import '../../features/rewards/application/child_rewards_controller.dart';
import '../../features/rewards/application/fulfilments_controller.dart';
import '../../features/rewards/application/program_draft_controller.dart';
import '../../features/rewards/application/programs_controller.dart';
import '../../features/rewards/application/suggestions_controller.dart';
import '../../features/rewards/data/reward_programs_repository.dart';
import '../../features/screen_time/api/screen_time_api.dart';
import '../../features/screen_time/application/app_block_rules_controller.dart';
import '../../features/screen_time/application/screen_time_overview_controller.dart';
import '../../features/screen_time/application/screen_time_policy_editor_controller.dart';
import '../../features/screen_time/data/screen_time_repository.dart';
import '../../features/screen_time/domain/app_block_rule.dart';
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

/// The boundary the ten Life Intelligence screens now read through, so that
/// `ApiException` -> `ApiFailure` happens once instead of ten times, and the
/// original error reaches the crash reporter on the way past. The API
/// provider above is untouched: `RewardProgramsRepository` still composes it
/// directly for the points balance, and nothing needed rewiring.
final lifeIntelligenceRepositoryProvider = Provider<LifeIntelligenceRepository>(
  (ref) => LifeIntelligenceRepository(ref.watch(lifeIntelligenceApiProvider)),
);
final billingApiProvider = Provider<BillingApi>((ref) => BillingApi(ref.watch(apiClientProvider)));

// PHASE G — THE STORE BILLING SEAM, AND THE ONE LINE THAT CLOSES IT.
//
// `UnavailableStoreBillingClient` refuses every purchase and says why. It is the
// only implementation in this repository, and that is a recorded decision rather
// than an omission: getting a Play `purchaseToken` needs `in_app_purchase` or a
// platform channel onto Android `BillingClient`, and a new dependency cannot be
// resolved or locked from the authoring environment (`pub.dev` blocked, no
// `pubspec.lock` committed — audit PA-M-016). See
// `features/billing/domain/store_billing_client.dart` for the full argument.
//
// WHEN THE PLUGIN IS ADDED, THIS LINE IS THE ONLY CHANGE HERE: swap
// `UnavailableStoreBillingClient()` for the real client. Nothing else in the app
// refers to a store SDK.
//
// It does NOT fall back to a path that grants a paid tier without a payment.
// That is exactly what `subscribe(tier, 'MANUAL')` used to do.
final storeBillingClientProvider = Provider<StoreBillingClient>(
  (ref) => const UnavailableStoreBillingClient(),
);

final subscriptionPurchaseCoordinatorProvider = Provider<SubscriptionPurchaseCoordinator>(
  (ref) => SubscriptionPurchaseCoordinator(
    ref.watch(billingApiProvider),
    ref.watch(storeBillingClientProvider),
  ),
);
final pushRegistrationServiceProvider = Provider<PushRegistrationService>((ref) => PushRegistrationService(ref.watch(pairingApiProvider)));
final supportApiProvider = Provider<SupportApi>((ref) => SupportApi(ref.watch(apiClientProvider)));
final consentApiProvider = Provider<ConsentApi>((ref) => ConsentApi(ref.watch(apiClientProvider)));
final accountApiProvider = Provider<AccountApi>((ref) => AccountApi(ref.watch(apiClientProvider)));
final campaignApiProvider = Provider<CampaignApi>((ref) => CampaignApi(ref.watch(apiClientProvider)));

// THE FOUR BOUNDARIES THE LAST FOUR `e.toString()` SCREENS NOW READ THROUGH.
//
// Same reasoning as `lifeIntelligenceRepositoryProvider` above: the API
// providers stay exactly as they are, because other callers already compose
// them, and the repository is added ALONGSIDE rather than in front. A screen
// that reads a repository gets the conversion and the crash-reporter hop for
// free; one that still reads an API is unchanged and still compiles, which is
// what keeps this a correctness pass rather than a migration.
final accountRepositoryProvider = Provider<AccountRepository>(
  (ref) => AccountRepository(ref.watch(accountApiProvider)),
);
final campaignRepositoryProvider = Provider<CampaignRepository>(
  (ref) => CampaignRepository(ref.watch(campaignApiProvider)),
);
final supportRepositoryProvider = Provider<SupportRepository>(
  (ref) => SupportRepository(ref.watch(supportApiProvider)),
);
final childProfileRepositoryProvider = Provider<ChildProfileRepository>(
  (ref) => ChildProfileRepository(
    ref.watch(dashboardApiProvider),
    ref.watch(pairingApiProvider),
    ref.watch(consentApiProvider),
  ),
);

// ---------------------------------------------------------------------------
// THE TWO SURFACES A DEEP LINK USED TO FALL OFF: SAFETY, AND ONE CHILD.
//
// Both are composed from APIs that ALREADY EXIST — `NotificationsApi.list()`
// (the inbox's own call) and `DashboardApi` (`/children` and
// `/children/:childId`). No second HTTP client, no new endpoint, and no route
// this backend does not serve. See `features/safety/domain/safety_event.dart`
// for why the safety feed reads the notifications route rather than
// `GET /pairing/alerts`.
// ---------------------------------------------------------------------------

final safetyRepositoryProvider = Provider<SafetyRepository>(
  (ref) => SafetyRepository(
    ref.watch(notificationsApiProvider),
    ref.watch(dashboardApiProvider),
  ),
);

/// `autoDispose` because a safety feed read on Tuesday is not the answer on
/// Thursday, and this screen is usually opened from a link about something that
/// has just happened. Keeping it alive would hand a parent a cached list on the
/// one surface where staleness is least acceptable.
final safetyControllerProvider =
    StateNotifierProvider.autoDispose<SafetyController, SafetyState>(
  (ref) => SafetyController(ref.watch(safetyRepositoryProvider)),
);

/// `family` on the childId, `autoDispose` for the same reason every other
/// id-scoped controller in this file is.
final childDetailControllerProvider = StateNotifierProvider.autoDispose
    .family<ChildDetailController, UiState<ChildProfile>, String>(
  (ref, childId) =>
      ChildDetailController(ref.watch(childProfileRepositoryProvider), childId),
);

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

// ---------------------------------------------------------------------------
// THE PARENT'S SCREEN-TIME SURFACE.
//
// Wired into the EXISTING container, on the EXISTING `apiClientProvider`, for
// the same reason the F4 block above is: no second HTTP client, no second auth
// path, no second refresh loop. The backend has served these seven routes for
// several sprints and this app had no consumer for any of them — no
// `features/screen_time/` directory existed at all, so `abny://screen-time`
// fell through to the safety feed and a headline feature was unreachable.
// ---------------------------------------------------------------------------

final screenTimeApiProvider = Provider<ScreenTimeApi>(
  (ref) => ScreenTimeApi(ref.watch(apiClientProvider)),
);

final screenTimeRepositoryProvider = Provider<ScreenTimeRepository>(
  (ref) => ScreenTimeRepository(ref.watch(screenTimeApiProvider)),
);

/// `family` on the childId and `autoDispose`, for the same reason every other
/// id-scoped controller in this file is — and one more that is specific to
/// this surface: the EFFECTIVE allowance is computed at request time from
/// grants that expire on their own, so a cached answer from an hour ago is a
/// different number from the truth. Nothing here may outlive the screen.
final screenTimeOverviewControllerProvider = StateNotifierProvider.autoDispose
    .family<ScreenTimeOverviewController, UiState<ScreenTimeOverview>, String>(
  (ref, childId) =>
      ScreenTimeOverviewController(ref.watch(screenTimeRepositoryProvider), childId),
);

final screenTimePolicyEditorControllerProvider = StateNotifierProvider.autoDispose
    .family<ScreenTimePolicyEditorController, PolicyEditorState, String>(
  (ref, childId) => ScreenTimePolicyEditorController(
    ref.watch(screenTimeRepositoryProvider),
    childId,
  ),
);

final appBlockRulesControllerProvider = StateNotifierProvider.autoDispose
    .family<AppBlockRulesController, AppBlockRulesState, String>(
  (ref, childId) =>
      AppBlockRulesController(ref.watch(screenTimeRepositoryProvider), childId),
);

/// The picker's catalogue. `autoDispose` because the answer is «what this
/// device reported», which a sync can change between two openings of the same
/// sheet — and because an empty answer must be RE-ASKED rather than remembered.
final childAppCatalogueControllerProvider = StateNotifierProvider.autoDispose
    .family<ChildAppCatalogueController, UiState<List<AppCatalogEntry>>, String>(
  (ref, childId) =>
      ChildAppCatalogueController(ref.watch(screenTimeRepositoryProvider), childId),
);

/// The family's children, for the wizard's first step and every
/// child-scoped screen. Reuses `GET /children` through the existing
/// DashboardApi rather than adding a second caller of the same route.
final familyChildrenProvider = FutureProvider.autoDispose<List<dynamic>>(
  (ref) => ref.watch(dashboardApiProvider).getChildren(),
);
