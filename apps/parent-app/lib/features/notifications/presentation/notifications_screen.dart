import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: unread notifications now get a colored accent bar and
/// filled dot instead of a plain outline/filled circle icon that was
/// easy to miss at a glance in a long list.
class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  List<dynamic>? _notifications;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(notificationsApiProvider).list();
      if (mounted) setState(() => _notifications = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  Future<void> _markAllRead() async {
    try {
      await ref.read(notificationsApiProvider).markAllAsRead();
    } catch (_) {
      // Already enqueued by NotificationsApi.
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(
        title: Text(t('notifications.title')),
        actions: [
          TextButton(onPressed: _markAllRead, child: Text(t('notifications.markAllRead'))),
        ],
      ),
      body: _errorMessage != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(t('common.error'), textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    FilledButton(onPressed: _load, child: Text(t('common.retry'))),
                  ],
                ),
              ),
            )
          : _notifications == null
              ? const Center(child: CircularProgressIndicator())
              : _notifications!.isEmpty
                  ? Center(child: Text(t('notifications.empty')))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        itemCount: _notifications!.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (context, index) {
                          final n = _notifications![index] as Map<String, dynamic>;
                          final isUnread = n['readAt'] == null;
                          return Container(
                            color: isUnread ? AppTheme.sage500.withOpacity(0.04) : null,
                            child: ListTile(
                              leading: Container(
                                width: 10,
                                height: 10,
                                margin: const EdgeInsets.only(top: 4),
                                decoration: BoxDecoration(
                                  color: isUnread ? AppTheme.sage500 : Colors.transparent,
                                  shape: BoxShape.circle,
                                  border: isUnread ? null : Border.all(color: Colors.grey.shade300),
                                ),
                              ),
                              title: Text(
                                n['title'] as String? ?? '',
                                style: TextStyle(fontWeight: isUnread ? FontWeight.w600 : FontWeight.w400),
                              ),
                              subtitle: Text(n['body'] as String? ?? ''),
                              onTap: isUnread
                                  ? () async {
                                      try {
                                        await ref.read(notificationsApiProvider).markAsRead(n['id'] as String);
                                      } catch (_) {
                                        // Already enqueued by NotificationsApi.
                                      }
                                      await _load();
                                    }
                                  : null,
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
