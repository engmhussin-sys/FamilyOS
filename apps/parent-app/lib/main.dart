import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/auth/session_expired_notifier.dart';
import 'core/connectivity/connectivity_controller.dart';
import 'core/di/providers.dart';
import 'core/localization/locale_controller.dart';
import 'core/offline/offline_banner.dart';
import 'core/routing/app_routes.dart';
import 'core/theme/app_theme.dart';
import 'features/authentication/presentation/login_screen.dart';
import 'features/authentication/presentation/register_screen.dart';
import 'features/authentication/presentation/splash_screen.dart';
import 'features/dashboard/presentation/dashboard_home_screen.dart';
import 'features/family/presentation/create_family_screen.dart';
import 'features/notifications/presentation/notifications_screen.dart';
import 'features/pairing/presentation/add_child_screen.dart';
import 'features/settings/presentation/settings_screen.dart';

void main() {
  runApp(const ProviderScope(child: ParentApp()));
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
      // No Flutter-native localization delegate is wired here — this
      // app's translation is `LocaleController`'s own mechanism (mirrors
      // the Dashboard's LocaleProvider), not `flutter_localizations`.
      // `Directionality` is set explicitly instead of relying on
      // `MaterialApp.locale`, for the same reason.
      builder: (context, child) => Directionality(
        textDirection: isRtl ? TextDirection.rtl : TextDirection.ltr,
        child: OfflineBanner(child: child!),
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
      },
    );
  }
}
