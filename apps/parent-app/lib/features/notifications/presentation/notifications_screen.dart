import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  List<dynamic>? _notifications;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final result = await ref.read(notificationsApiProvider).list();
    if (mounted) setState(() => _notifications = result);
  }

  Future<void> _markAllRead() async {
    await ref.read(notificationsApiProvider).markAllAsRead();
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(
        title: Text(t('notifications.title')),
        actions: [
          TextButton(onPressed: _markAllRead, child: Text(t('notifications.markAllRead'))),
        ],
      ),
      body: _notifications == null
          ? const Center(child: CircularProgressIndicator())
          : _notifications!.isEmpty
              ? Center(child: Text(t('notifications.empty')))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView.builder(
                    itemCount: _notifications!.length,
                    itemBuilder: (context, index) {
                      final n = _notifications![index] as Map<String, dynamic>;
                      final isUnread = n['readAt'] == null;
                      return ListTile(
                        leading: Icon(isUnread ? Icons.circle : Icons.circle_outlined, size: 12),
                        title: Text(n['title'] as String? ?? ''),
                        subtitle: Text(n['body'] as String? ?? ''),
                        onTap: isUnread
                            ? () async {
                                await ref.read(notificationsApiProvider).markAsRead(n['id'] as String);
                                await _load();
                              }
                            : null,
                      );
                    },
                  ),
                ),
    );
  }
}
