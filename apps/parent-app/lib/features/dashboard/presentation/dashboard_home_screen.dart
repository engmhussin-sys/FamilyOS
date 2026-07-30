import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';
import '../../authentication/application/auth_controller.dart';

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

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
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
    } catch (_) {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
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
