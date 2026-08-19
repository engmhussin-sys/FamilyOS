import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/auth/session_expired_notifier.dart';
import 'core/config/app_config.dart';
import 'core/connectivity/connectivity_controller.dart';
import 'core/di/providers.dart';
import 'core/localization/locale_controller.dart';
import 'core/offline/offline_banner.dart';
import 'core/routing/app_routes.dart';
import 'core/routing/deep_link_host.dart';
import 'core/theme/app_theme.dart';
import 'features/authentication/presentation/login_screen.dart';
import 'features/authentication/presentation/register_screen.dart';
import 'features/authentication/presentation/splash_screen.dart';
import 'features/dashboard/presentation/dashboard_home_screen.dart';
import 'features/family/presentation/create_family_screen.dart';
import 'features/notifications/presentation/notifications_screen.dart';
import 'features/pairing/presentation/add_child_screen.dart';
import 'features/settings/presentation/settings_screen.dart';
import 'features/billing/presentation/subscription_screen.dart';
import 'features/billing/presentation/billing_history_screen.dart';
import 'features/support/presentation/support_home_screen.dart';
import 'features/support/presentation/contact_support_screen.dart';
import 'features/family/presentation/create_child_screen.dart';
import 'features/family/presentation/manage_consents_screen.dart';
import 'features/settings/presentation/delete_account_screen.dart';
import 'features/billing/presentation/redeem_code_screen.dart';
import 'core/observability/crash_reporting.dart';
import 'features/rewards/presentation/fulfilments_screen.dart';
import 'features/rewards/presentation/pending_achievements_screen.dart';
import 'features/rewards/presentation/programs_list_screen.dart';
import 'features/safety/presentation/safety_screen.dart';
import 'features/screen_time/presentation/screen_time_children_screen.dart';
import 'features/life_intelligence/presentation/coach_children_screen.dart';
import 'features/rewards/presentation/progress_children_screen.dart';

void main() {
  // F2 (audit MA-004) — identical guard to the child app's main(), for the
  // identical reason. First statement, before the Sentry zone.
  AppConfig.assertUsableForBuildMode();
  bootstrapWithCrashReporting(() async {
    runApp(const ProviderScope(child: ParentApp()));
  });
}

final _navigatorKey = GlobalKey<NavigatorState>();

class ParentApp extends ConsumerWidget {
  const ParentApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final isRtl = ref.watch(localeControllerProvider.notifier).isRtl;

    // PRODUCTION READINESS REVIEW FIX (API Review — Unauthorized
    // Handling): reacts to ApiClient's onSessionExpired callback
    // (bumped via sessionExpiredProvider) by forcing navigation to
    // Login from wherever the user currently is — closes the gap where
    // a mid-session refresh failure left the user stranded on a screen
    // with a dead session and no path back to Login.
    ref.listen(sessionExpiredProvider, (previous, next) {
      if (previous != null && next != previous) {
        _navigatorKey.currentState?.pushNamedAndRemoveUntil(AppRoutes.login, (route) => false);
      }
    });

    // Auto-retry requirement (Offline Detection): when connectivity
    // flips from offline -> online, drain every queued write action
    // against the real API. Runs once per transition, not on every
    // rebuild — `ref.listen` only fires on an actual state change.
    ref.listen(connectivityControllerProvider, (previous, isOnline) {
      if (previous == false && isOnline == true) {
        // NotificationsApi is the only producer of queued operations
        // today — replay routes through it directly rather than a
        // generic dispatcher table, since there's exactly one real
        // consumer to route to (see NotificationsApi.replay's own
        // switch statement for how a second producer would extend this).
        ref.read(pendingOperationsQueueProvider).drain(
              (operation) => ref.read(notificationsApiProvider).replay(operation),
            );
      }
    });

    return MaterialApp(
      navigatorKey: _navigatorKey,
      title: 'FamilyOS',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      // CLOSES A REAL GAP (Master Completeness Audit): this app's own
      // translation still runs through LocaleController (unchanged,
      // see below) — this addition is ONLY for native Material
      // widgets (showDatePicker, default dialog button labels) that
      // read Flutter's own Locale directly and never went through
      // Directionality alone.
      locale: ref.watch(localeControllerProvider.notifier).toLocale,
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      // Arabic FIRST: `supportedLocales` order is also the resolution
      // preference order Flutter falls back through when the device
      // locale matches none of them. For an Arabic-first product that
      // fallback must be Arabic, not English (audit MA-016).
      supportedLocales: const [Locale('ar'), Locale('en')],
      // No Flutter-native localization delegate is wired here for THIS
      // app's own text — that stays LocaleController's mechanism
      // (mirrors the Dashboard's LocaleProvider), not
      // flutter_localizations. `Directionality` is set explicitly
      // below for the same reason — both of these remain correct and
      // unchanged; flutter_localizations above is additive, for
      // native widgets only.
      // `DeepLinkHost` is here rather than on a screen because an OS-delivered
      // `abny://` link can arrive at ANY moment, including before the first
      // screen exists (a cold start FOR the link) and while any screen is on
      // top (a warm start). `builder` runs above the Navigator and for the
      // whole life of the app, which is exactly the scope that listener needs;
      // it is handed `_navigatorKey` for the same reason — from up here
      // `Navigator.of(context)` would find nothing. It renders `child`
      // untouched and decides only WHEN a link is followed.
      builder: (context, child) => Directionality(
        textDirection: isRtl ? TextDirection.rtl : TextDirection.ltr,
        child: DeepLinkHost(
          navigatorKey: _navigatorKey,
          child: OfflineBanner(child: child!),
        ),
      ),
      initialRoute: AppRoutes.splash,
      routes: {
        AppRoutes.splash: (_) => const SplashScreen(),
        AppRoutes.login: (_) => const LoginScreen(),
        AppRoutes.register: (_) => const RegisterScreen(),
        AppRoutes.familySetup: (_) => const CreateFamilyScreen(),
        AppRoutes.dashboard: (_) => const DashboardHomeScreen(),
        AppRoutes.addChild: (_) => const AddChildScreen(),
        AppRoutes.notifications: (_) => const NotificationsScreen(),
        AppRoutes.settings: (_) => const SettingsScreen(),
        AppRoutes.subscription: (_) => const SubscriptionScreen(),
        AppRoutes.billingHistory: (_) => const BillingHistoryScreen(),
        AppRoutes.support: (_) => const SupportHomeScreen(),
        AppRoutes.contactSupport: (_) => const ContactSupportScreen(),
        AppRoutes.createChild: (_) => const CreateChildScreen(),
        AppRoutes.manageConsents: (_) => const ManageConsentsScreen(),
        AppRoutes.deleteAccount: (_) => const DeleteAccountScreen(),
        AppRoutes.redeemCode: (_) => const RedeemCodeScreen(),
        // B6 — the F4 surface. Family-wide by default; the child-scoped
        // variants are pushed with constructor arguments instead.
        AppRoutes.goals: (_) => const ProgramsListScreen(),
        AppRoutes.goalReviewQueue: (_) => const PendingAchievementsScreen(),
        AppRoutes.fulfilments: (_) => const FulfilmentsScreen(),
        // F1 — the safety & protection surface. Argument-free, which is
        // what qualifies it for this table; `abny://safety/<alertId>` is
        // pushed as a page instead. See `deep_link_router.dart`.
        AppRoutes.safety: (_) => const SafetyScreen(),
        // The parent's screen-time surface, and where `abny://screen-time`
        // now lands. Argument-free by design: the link names no child, so
        // this screen resolves «which child» from the family's own data
        // rather than taking an id it was never given. See its header.
        AppRoutes.screenTime: (_) => const ScreenTimeChildrenScreen(),
        // WHERE `abny://progress` LANDS, and it is the repair of a dead tap on
        // the two most-sent parent notifications — `REWARD_GRANTED` and
        // `BADGE_EARNED_PARENT` both resolve to that link, and the router
        // answered it with `unavailable()` until this screen existed.
        // Argument-free for the same reason `screenTime` above is: the link
        // names no child, and the screen asks the family's data instead of
        // taking an id it was never given.
        AppRoutes.progress: (_) => const ProgressChildrenScreen(),
        // The same repair for the other refused surface. No key resolves to
        // `abny://coach` today, but the surface is in the scheme and a surface
        // the app cannot open is the defect, not the traffic on it.
        AppRoutes.coach: (_) => const CoachChildrenScreen(),
      },
    );
  }
}
