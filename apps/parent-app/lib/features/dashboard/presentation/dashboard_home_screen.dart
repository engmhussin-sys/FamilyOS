import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';
import '../../authentication/application/auth_controller.dart';
import '../../life_intelligence/presentation/digital_twin_screen.dart';
import '../../life_intelligence/presentation/life_timeline_screen.dart';
import '../../life_intelligence/presentation/habit_tracker_screen.dart';
import '../../life_intelligence/presentation/health_trend_screen.dart';
import '../../life_intelligence/presentation/faith_progress_screen.dart';
import '../../life_intelligence/presentation/family_store_screen.dart';
import '../../life_intelligence/presentation/coaching_screen.dart';

class DashboardHomeScreen extends ConsumerStatefulWidget {
  const DashboardHomeScreen({super.key});

  @override
  ConsumerState<DashboardHomeScreen> createState() => _DashboardHomeScreenState();
}

class _DashboardHomeScreenState extends ConsumerState<DashboardHomeScreen> {
  List<dynamic>? _children;
  List<dynamic>? _devices;
  int _unreadCount = 0;
  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    final api = ref.read(dashboardApiProvider);
    try {
      final results = await Future.wait([
        api.getChildren(),
        api.getDevices(),
        api.getUnreadNotificationCount(),
      ]);
      if (!mounted) return;
      setState(() {
        _children = results[0] as List<dynamic>;
        _devices = results[1] as List<dynamic>;
        _unreadCount = results[2] as int;
        _isLoading = false;
      });
    } catch (e) {
      // PRODUCTION READINESS REVIEW FIX (UI/UX Review — Error State):
      // this catch block previously discarded the error entirely,
      // leaving `_children`/`_devices` null and `_isLoading` false —
      // which rendered as an empty dashboard indistinguishable from "no
      // children yet," silently hiding a real network/server failure
      // from the user with no way to retry.
      if (mounted) {
        setState(() {
          _isLoading = false;
          _errorMessage = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider); // registers rebuild dependency — see fix note below
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(
        title: Text(t('dashboard.title')),
        actions: [
          IconButton(
            icon: Badge(
              label: Text('$_unreadCount'),
              isLabelVisible: _unreadCount > 0,
              child: const Icon(Icons.notifications_outlined),
            ),
            onPressed: () => Navigator.of(context).pushNamed(AppRoutes.notifications),
          ),
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Navigator.of(context).pushNamed(AppRoutes.settings),
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _errorMessage != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.wifi_off, size: 40, color: Theme.of(context).colorScheme.error),
                        const SizedBox(height: 12),
                        Text(t('common.error'), textAlign: TextAlign.center),
                        const SizedBox(height: 16),
                        FilledButton(onPressed: _load, child: Text(t('common.retry'))),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _FamilySummaryCard(
                    childrenCount: _children?.length ?? 0,
                    devicesCount: _devices?.length ?? 0,
                    alertsCount: _unreadCount,
                    t: t,
                  ),
                  const SizedBox(height: 16),
                  ...?_children?.map((child) => _ChildCard(child: child, devices: _devices ?? [], t: t)),
                  const SizedBox(height: 16),
                  _QuickActions(t: t),
                ],
              ),
            ),
    );
  }
}

class _FamilySummaryCard extends StatelessWidget {
  const _FamilySummaryCard({
    required this.childrenCount,
    required this.devicesCount,
    required this.alertsCount,
    required this.t,
  });

  final int childrenCount;
  final int devicesCount;
  final int alertsCount;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(t('dashboard.familySummary'), style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(t('dashboard.children', count: childrenCount)),
                Text(t('dashboard.devices', options: {'count': devicesCount})),
                Text(t('dashboard.alerts', options: {'count': alertsCount})),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ChildCard extends StatelessWidget {
  const _ChildCard({required this.child, required this.devices, required this.t});

  final dynamic child;
  final List<dynamic> devices;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    final childDevice = devices.cast<Map<String, dynamic>?>().firstWhere(
          (d) => d?['childId'] == child['id'],
          orElse: () => null,
        );
    final isOnline = childDevice != null && childDevice['lastSeenAt'] != null;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: CircleAvatar(child: Text((child['firstName'] as String? ?? '?').characters.first)),
        title: Text(child['firstName'] as String? ?? ''),
        subtitle: Text(isOnline ? t('dashboard.online') : t('dashboard.offline')),
        trailing: childDevice != null
            ? Chip(label: Text('${childDevice['riskLevel'] ?? 'UNKNOWN'}'))
            : null,
        onTap: () => _showChildActions(context, child, t),
      ),
    );
  }

  void _showChildActions(BuildContext context, dynamic child, String Function(String, {int? count, Map<String, Object>? options}) t) {
    final childId = child['id'] as String;
    final childName = child['firstName'] as String? ?? '';
    final familyId = child['familyId'] as String?;
    showModalBottomSheet(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.auto_awesome_outlined),
              title: Text(t('digitalTwin.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => DigitalTwinScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.timeline_outlined),
              title: Text(t('lifeTimeline.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => LifeTimelineScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.checklist_outlined),
              title: Text(t('habitTracker.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => HabitTrackerScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.favorite_outline),
              title: Text(t('healthTrend.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => HealthTrendScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.mosque_outlined),
              title: Text(t('faithProgress.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => FaithProgressScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.psychology_outlined),
              title: Text(t('coaching.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => CoachingScreen(childId: childId, childName: childName)),
                );
              },
            ),
            if (familyId != null)
              ListTile(
                leading: const Icon(Icons.storefront_outlined),
                title: Text(t('familyStore.title')),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => FamilyStoreScreen(familyId: familyId)),
                  );
                },
              ),
          ],
        ),
      ),
    );
  }
}

class _QuickActions extends ConsumerWidget {
  const _QuickActions({required this.t});

  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        FilledButton.icon(
          onPressed: () => Navigator.of(context).pushNamed(AppRoutes.addChild),
          icon: const Icon(Icons.add),
          label: Text(t('dashboard.addChild')),
        ),
        OutlinedButton.icon(
          onPressed: null, // Reports (Sprint 8, backend-real) — mobile screen not built this sprint
          icon: const Icon(Icons.insert_chart_outlined),
          label: Text(t('dashboard.viewReports')),
        ),
        TextButton(
          onPressed: () async {
            await ref.read(authControllerProvider.notifier).logout();
            if (context.mounted) {
              Navigator.of(context).pushNamedAndRemoveUntil(AppRoutes.login, (route) => false);
            }
          },
          child: Text(t('settings.logout')),
        ),
      ],
    );
  }
}
