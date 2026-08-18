import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/localization/localization_engine.dart';
import '../../../core/routing/app_routes.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: each row now has a soft colored icon badge instead of
/// a bare default-tint icon, and disabled/coming-soon rows are
/// visually dimmed rather than looking identical to active ones
/// until tapped (a real usability gap — previously a user couldn't
/// tell "not built yet" from "just needs a tap" without trying).
///
/// UX/UI REVIEW FIX: was a ConsumerWidget (stateless) — the logout
/// button ran a real async network call (authControllerProvider's
/// own logout) with ZERO loading indicator and ZERO double-tap
/// protection, the one real gap this systematic review found across
/// every screen in this app. Converted to ConsumerStatefulWidget
/// specifically to support that loading state.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  bool _isLoggingOut = false;

  Future<void> _logout() async {
    if (_isLoggingOut) return; // real double-tap protection, not just a visual nicety
    setState(() => _isLoggingOut = true);
    try {
      await ref.read(authControllerProvider.notifier).logout();
      if (mounted) {
        Navigator.of(context).pushNamedAndRemoveUntil(AppRoutes.login, (route) => false);
      }
    } catch (_) {
      // Best-effort — if logout's own network call fails, the user
      // can simply tap again; re-enabling the button (below) rather
      // than leaving it permanently disabled on a transient failure.
      if (mounted) setState(() => _isLoggingOut = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;
    final currentLocale = ref.watch(localeControllerProvider);

    return Scaffold(
      appBar: AppBar(title: Text(t('settings.title'))),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: DsSpace.sm),
        children: [
          _SettingsRow(
            icon: Icons.language_rounded,
            color: AppTheme.sage500,
            title: t('settings.language'),
            trailing: DropdownButton<AppLocale>(
              value: currentLocale,
              underline: const SizedBox.shrink(),
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
          _SettingsRow(
            icon: Icons.person_outline_rounded,
            color: AppTheme.guardian950,
            title: t('settings.profile'),
            onTap: null,
          ),
          _SettingsRow(
            icon: Icons.workspace_premium_outlined,
            color: AppTheme.amber500,
            title: t('settings.subscription'),
            onTap: () => Navigator.of(context).pushNamed(AppRoutes.subscription),
          ),
          _SettingsRow(
            icon: Icons.privacy_tip_outlined,
            color: AppTheme.guardian950,
            title: t('settings.privacy'),
            onTap: null,
          ),
          _SettingsRow(
            icon: Icons.help_outline_rounded,
            color: AppTheme.sage500,
            title: t('support.title'),
            onTap: () => Navigator.of(context).pushNamed(AppRoutes.support),
          ),
          _SettingsRow(
            icon: Icons.verified_user_outlined,
            color: AppTheme.sage500,
            title: t('consents.title'),
            onTap: () => Navigator.of(context).pushNamed(AppRoutes.manageConsents),
          ),
          const Padding(padding: EdgeInsets.symmetric(vertical: DsSpace.sm), child: Divider(height: 1)),
          _SettingsRow(
            icon: Icons.delete_forever_rounded,
            color: AppTheme.brick500,
            title: t('deleteAccount.title'),
            onTap: () => Navigator.of(context).pushNamed(AppRoutes.deleteAccount),
          ),
          _SettingsRow(
            icon: Icons.logout_rounded,
            color: AppTheme.brick500,
            title: t('settings.logout'),
            trailing: _isLoggingOut ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : null,
            onTap: _isLoggingOut ? null : _logout,
          ),
        ],
      ),
    );
  }
}

class _SettingsRow extends StatelessWidget {
  const _SettingsRow({
    required this.icon,
    required this.color,
    required this.title,
    this.subtitle,
    this.trailing,
    required this.onTap,
  });

  final IconData icon;
  final Color color;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final isDisabled = onTap == null && trailing == null;
    return Opacity(
      opacity: isDisabled ? 0.5 : 1.0,
      child: ListTile(
        leading: Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(color: color.withOpacity(0.12), shape: BoxShape.circle),
          child: Icon(icon, color: color, size: 19),
        ),
        title: Text(title),
        subtitle: subtitle != null ? Text(subtitle!) : null,
        trailing: trailing,
        onTap: onTap,
      ),
    );
  }
}
