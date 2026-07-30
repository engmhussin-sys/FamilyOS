import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/localization/locale_controller.dart';
import '../../../core/localization/localization_engine.dart';
import '../../../core/routing/app_routes.dart';
import '../../authentication/application/auth_controller.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(localeControllerProvider.notifier).t;
    final currentLocale = ref.watch(localeControllerProvider);

    return Scaffold(
      appBar: AppBar(title: Text(t('settings.title'))),
      body: ListView(
        children: [
          ListTile(
            leading: const Icon(Icons.language),
            title: Text(t('settings.language')),
            trailing: DropdownButton<AppLocale>(
              value: currentLocale,
              items: const [
                DropdownMenuItem(value: AppLocale.en, child: Text('English')),
                DropdownMenuItem(value: AppLocale.ar, child: Text('العربية')),
              ],
              onChanged: (locale) {
                if (locale != null) {
                  ref.read(localeControllerProvider.notifier).setLocale(locale);
                }
              },
            ),
          ),
          ListTile(
            leading: const Icon(Icons.person_outline),
            title: Text(t('settings.profile')),
            // Profile edit form — real backend endpoint exists (GET/PATCH
            // /profile, SettingsApi already wired) — screen UI deferred,
            // not attempted incompletely here.
            onTap: null,
          ),
          ListTile(
            leading: const Icon(Icons.workspace_premium_outlined),
            title: Text(t('settings.subscription')),
            // Billing (Sprint 8, backend-real) — mobile screen not built this sprint.
            subtitle: const Text('Coming soon'),
            onTap: null,
          ),
          ListTile(
            leading: const Icon(Icons.privacy_tip_outlined),
            title: Text(t('settings.privacy')),
            // Consent/Data Export (Sprint 1, backend-real) — mobile screen not built this sprint.
            onTap: null,
          ),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.logout),
            title: Text(t('settings.logout')),
            onTap: () async {
              await ref.read(authControllerProvider.notifier).logout();
              if (context.mounted) {
                Navigator.of(context).pushNamedAndRemoveUntil(AppRoutes.login, (route) => false);
              }
            },
          ),
        ],
      ),
    );
  }
}
