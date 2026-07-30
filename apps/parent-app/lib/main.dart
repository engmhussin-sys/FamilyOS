import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/localization/locale_controller.dart';
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

class ParentApp extends ConsumerWidget {
  const ParentApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isRtl = ref.watch(localeControllerProvider.notifier).isRtl;

    return MaterialApp(
      title: 'FamilyOS',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      // No Flutter-native localization delegate is wired here — this
      // app's translation is `LocaleController`'s own mechanism (mirrors
      // the Dashboard's LocaleProvider), not `flutter_localizations`.
      // `Directionality` is set explicitly instead of relying on
      // `MaterialApp.locale`, for the same reason.
      builder: (context, child) => Directionality(
        textDirection: isRtl ? TextDirection.rtl : TextDirection.ltr,
        child: child!,
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
