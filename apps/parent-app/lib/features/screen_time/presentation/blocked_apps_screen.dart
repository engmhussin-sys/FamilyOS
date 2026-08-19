import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../application/app_block_rules_controller.dart';
import '../domain/app_block_rule.dart';

/// BLOCKED APPS — the active rules, a way to stop one, and a picker that lists
/// the apps the child's device has actually reported.
///
/// THREE ROUTES:
///   * `GET    /children/:childId/app-block-rules`        — active rules only.
///   * `DELETE /children/:childId/app-block-rules/:ruleId` — DEACTIVATES the
///     rule. The server flips `isActive` and keeps the row together with its
///     `screenTime.appBlockRule.deactivated` audit entry, so the copy on this
///     screen says «إيقاف» and never «حذف». Calling it a delete would be a
///     false statement about what the button does.
///   * `GET    /children/:childId/apps`                   — the catalogue.
///
/// WHY THE PICKER IS THE POINT. Without it a parent can only block an app by
/// typing `com.example.thing` from memory — which is the state this feature
/// shipped in until the catalogue route was built. The picker turns that into
/// a choice from a list ordered most-recently-used first.
///
/// AND WHEN THE LIST IS EMPTY, THE SCREEN SAYS WHY. An empty catalogue means
/// the child's device has not reported an inventory yet, or no device is
/// paired at all. An empty sheet with no explanation is the failure mode this
/// whole thing exists to remove, so `empty` is a first-class state here with
/// its own Arabic sentence. NOTHING IS FABRICATED to fill it: a placeholder
/// app list would be package names this app invented, which a parent could
/// then block on a device that does not have them.
class BlockedAppsScreen extends ConsumerWidget {
  const BlockedAppsScreen({super.key, required this.childId, this.childName});

  final String childId;
  final String? childName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(appBlockRulesControllerProvider(childId));
    final controller = ref.read(appBlockRulesControllerProvider(childId).notifier);

    return Scaffold(
      appBar: AppBar(
        title: Text(childName == null || childName!.isEmpty
            ? t('blockedApps.title')
            : t('blockedApps.titleForChild', options: {'name': childName!})),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: state.creating ? null : () => _openPicker(context, ref),
        icon: const Icon(Icons.add_rounded),
        label: Text(t('blockedApps.addAction')),
      ),
      body: RefreshIndicator(
        onRefresh: controller.load,
        child: Column(
          children: [
            if (state.actionFailure != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: DsSpace.lg),
                child: DsErrorState(
                  failure: state.actionFailure!,
                  title: t('blockedApps.actionFailedTitle'),
                  retryLabel: t('common.dismiss'),
                  requestIdLabel: t('common.requestId'),
                  arabic: locale.isRtl,
                  compact: true,
                  onRetry: controller.clearActionFailure,
                ),
              ),
            if (state.lastCreatedTarget != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                    DsSpace.lg, DsSpace.md, DsSpace.lg, 0),
                child: DsSuccessBanner(
                  message: t('blockedApps.addedBanner',
                      options: {'target': state.lastCreatedTarget!}),
                  onDismiss: controller.clearBanners,
                ),
              ),
            if (state.lastStoppedTarget != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                    DsSpace.lg, DsSpace.md, DsSpace.lg, 0),
                child: DsSuccessBanner(
                  message: t('blockedApps.stoppedBanner',
                      options: {'target': state.lastStoppedTarget!}),
                  onDismiss: controller.clearBanners,
                ),
              ),
            Expanded(
              child: DsStateView<List<AppBlockRule>>(
                state: state.rules,
                arabic: locale.isRtl,
                loadingLabel: t('common.loading'),
                emptyTitle: t('blockedApps.emptyTitle'),
                emptyBody: t('blockedApps.emptyBody'),
                emptyIcon: Icons.apps_outlined,
                emptyActionLabel: t('blockedApps.addAction'),
                onEmptyAction: () => _openPicker(context, ref),
                errorTitle: t('blockedApps.errorTitle'),
                retryLabel: t('common.retry'),
                requestIdLabel: t('common.requestId'),
                onRetry: controller.load,
                builder: (context, rules) => ListView(
                  padding: DsSpace.screen,
                  children: [
                    Text(t('blockedApps.listNote'), style: DsText.caption(context)),
                    DsSpace.gapMd,
                    for (final rule in rules)
                      _RuleCard(
                        rule: rule,
                        busy: state.busyRuleId == rule.id,
                        onStop: () => _confirmStop(context, t, controller, rule),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _openPicker(BuildContext context, WidgetRef ref) async {
    final picked = await showModalBottomSheet<AppCatalogEntry>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _AppPickerSheet(childId: childId),
    );
    if (picked == null) return;
    if (!context.mounted) return;
    await ref
        .read(appBlockRulesControllerProvider(childId).notifier)
        .blockPackage(picked.packageName);
  }

  Future<void> _confirmStop(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    AppBlockRulesController controller,
    AppBlockRule rule,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(t('blockedApps.stopConfirmTitle')),
        // Says what actually happens: the rule stops being enforced, the row
        // stays. Not «this will be deleted», which the server does not do.
        content: Text(t('blockedApps.stopConfirmBody', options: {'target': rule.target})),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(t('common.cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(t('blockedApps.stop')),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.stopRule(rule);
  }
}

class _RuleCard extends ConsumerWidget {
  const _RuleCard({required this.rule, required this.busy, required this.onStop});

  final AppBlockRule rule;
  final bool busy;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    // A server value used to build a key: `has` first, so an unrecognised rule
    // type falls back to something readable instead of putting «appRuleType.FOO»
    // on a parent's screen.
    final typeKey = 'appRuleType.${rule.ruleType}';
    final typeLabel = locale.has(typeKey) ? t(typeKey) : t('appRuleType.unknown');

    return DsCard(
      accent: rule.ruleType == AppRuleTypes.allow
          ? DsColor.stateSuccess
          : DsColor.stateError,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  rule.target,
                  style: DsText.cardTitle(context),
                  // A package name is an IDENTIFIER, not prose: it reads
                  // left-to-right even inside an Arabic layout, and it is never
                  // translated because it has to keep matching what the device
                  // enforces on.
                  textDirection: TextDirection.ltr,
                ),
              ),
              DsSpace.hGapSm,
              DsBadge(label: typeLabel),
            ],
          ),
          DsSpace.gapXs,
          Text(
            rule.targetsCategory
                ? t('blockedApps.targetCategory')
                : t('blockedApps.targetPackage'),
            style: DsText.caption(context),
          ),
          if (rule.limitMinutes != null) ...[
            DsSpace.gapXs,
            Text(
              t('blockedApps.limitMinutes', options: {'count': rule.limitMinutes!}),
              style: DsText.caption(context),
            ),
          ],
          DsSpace.gapMd,
          DsSecondaryButton(
            label: t('blockedApps.stop'),
            icon: Icons.pause_circle_outline_rounded,
            danger: true,
            onPressed: busy ? null : onStop,
          ),
        ],
      ),
    );
  }
}

/// THE PICKER — `GET /children/:childId/apps`.
///
/// Four states, all worded, because the empty one is the whole reason this
/// route was built and the one a parent is most likely to hit on day one.
class _AppPickerSheet extends ConsumerWidget {
  const _AppPickerSheet({required this.childId});

  final String childId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(childAppCatalogueControllerProvider(childId));
    final controller = ref.read(childAppCatalogueControllerProvider(childId).notifier);

    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.75,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(DsSpace.lg),
              child: DsSectionHeader(
                title: t('appPicker.title'),
                subtitle: t('appPicker.hint'),
              ),
            ),
            Expanded(
              child: DsStateView<List<AppCatalogEntry>>(
                state: state,
                arabic: locale.isRtl,
                loadingLabel: t('common.loading'),
                // THE HONEST EMPTY STATE. It names both causes — no device
                // paired, or paired and not yet synced — because a parent can
                // act on the first and only wait on the second.
                emptyTitle: t('appPicker.emptyTitle'),
                emptyBody: t('appPicker.emptyBody'),
                emptyIcon: Icons.phonelink_erase_outlined,
                emptyActionLabel: t('common.retry'),
                onEmptyAction: controller.load,
                errorTitle: t('appPicker.errorTitle'),
                retryLabel: t('common.retry'),
                requestIdLabel: t('common.requestId'),
                onRetry: controller.load,
                builder: (context, apps) => ListView(
                  padding: DsSpace.screen,
                  children: [
                    Text(t('appPicker.capNote'), style: DsText.caption(context)),
                    DsSpace.gapMd,
                    for (final app in apps)
                      _AppRow(
                        app: app,
                        onTap: () => Navigator.of(context).pop(app),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One row of the catalogue. NOT a `ConsumerWidget`: every string it renders
/// is either the device's own (`appName`, `packageName`) or none at all, so it
/// has nothing to read from the locale and nothing to watch.
class _AppRow extends StatelessWidget {
  const _AppRow({required this.app, required this.onTap});

  final AppCatalogEntry app;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return DsCard(
      onTap: onTap,
      padding: const EdgeInsets.all(DsSpace.md),
      child: Row(
        children: [
          _AppIcon(app: app),
          DsSpace.hGapMd,
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(app.displayName, style: DsText.cardTitle(context)),
                DsSpace.gapXs,
                Text(
                  app.packageName,
                  style: DsText.caption(context),
                  textDirection: TextDirection.ltr,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The app's icon, or a glyph. [AppCatalogEntry.hasSafeIcon] is what decides:
/// only an `https:` URL is loaded, because this app ships a network-security
/// config that forbids cleartext and an `Image.network` pointed at whatever
/// string arrived would be the one place that could break it. A failed fetch
/// falls back to the same glyph rather than to a broken-image box.
class _AppIcon extends StatelessWidget {
  const _AppIcon({required this.app});

  final AppCatalogEntry app;

  @override
  Widget build(BuildContext context) {
    const double size = 40;
    if (!app.hasSafeIcon) return const _AppGlyph(size: size);
    return ClipRRect(
      borderRadius: DsRadius.controlBorder,
      child: Image.network(
        app.iconUrl!,
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => const _AppGlyph(size: size),
      ),
    );
  }
}

class _AppGlyph extends StatelessWidget {
  const _AppGlyph({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: DsColor.accent.withOpacity(0.12),
        borderRadius: DsRadius.controlBorder,
      ),
      child: const Icon(Icons.android_rounded, color: DsColor.accent, size: DsIconSize.md),
    );
  }
}
