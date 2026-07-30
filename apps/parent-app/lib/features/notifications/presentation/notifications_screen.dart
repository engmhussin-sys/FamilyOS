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
      // PRODUCTION READINESS REVIEW FIX (UI/UX Review — Error State):
      // previously unhandled — a failure here left `_notifications` null
      // forever, showing an infinite loading spinner with no way out.
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  Future<void> _markAllRead() async {
    try {
      await ref.read(notificationsApiProvider).markAllAsRead();
    } catch (_) {
      // Already enqueued by NotificationsApi — no error surfaced here;
      // the OfflineBanner's pending-count badge is the feedback.
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider); // registers rebuild dependency — see fix note below
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
                                try {
                                  await ref.read(notificationsApiProvider).markAsRead(n['id'] as String);
                                } catch (_) {
                                  // Already enqueued by NotificationsApi.
                                }
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
