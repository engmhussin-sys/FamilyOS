import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/notifications/push_registration_service.dart';
import '../../../core/routing/deep_link.dart';
import '../../../core/routing/deep_link_router.dart';
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

  /// THE B3 ENVELOPE, not `e.toString()`. The error state used to render a
  /// fixed `t('common.error')` line and throw the server's own `messageAr`
  /// away — so a parent whose inbox failed to load was told «حدث خطأ» while
  /// the server had already written the reason in Arabic.
  ApiFailure? _failure;

  /// G18. Null until the first read completes, so nothing is claimed about the
  /// permission before it has actually been checked.
  ParentNotificationPermissionState? _permissionState;

  /// G18. Set once the parent has answered the system dialog in this session, so
  /// a "denied" answer does not immediately redraw the same banner underneath
  /// the snackbar explaining the denial. No nagging within one visit.
  bool _permissionAsked = false;

  @override
  void initState() {
    super.initState();
    _load();
    _refreshPermissionState();
  }

  /// G18 — reads the permission WITHOUT prompting.
  ///
  /// The banner is offered only when there is a real dialog to show and a real
  /// channel to deliver on: `unavailable` (no Firebase in this build) shows
  /// nothing at all, because asking for a permission that could not be used
  /// would be a lie about what this build can do.
  Future<void> _refreshPermissionState() async {
    final state =
        await ref.read(pushRegistrationServiceProvider).currentPermissionState();
    if (mounted) setState(() => _permissionState = state);
  }

  Future<void> _requestPermission() async {
    setState(() => _permissionAsked = true);
    final state = await ref
        .read(pushRegistrationServiceProvider)
        .requestPermissionAfterExplanation();
    if (!mounted) return;
    setState(() => _permissionState = state);

    final t = ref.read(localeControllerProvider.notifier).t;
    final message = switch (state) {
      ParentNotificationPermissionState.granted => t('notifications.permGranted'),
      ParentNotificationPermissionState.denied ||
      ParentNotificationPermissionState.notRequested =>
        t('notifications.permDenied'),
      // Nothing useful to say about a build with no Firebase, and the banner
      // was never shown in that state anyway.
      ParentNotificationPermissionState.unavailable => null,
    };
    if (message == null) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 5)),
    );
  }

  Future<void> _load() async {
    setState(() => _failure = null);
    try {
      final result = await ref.read(notificationsApiProvider).list();
      if (mounted) setState(() => _notifications = result);
    } catch (e) {
      if (mounted) setState(() => _failure = ApiFailure.from(e));
    }
  }

  /// THE TAP THAT FINALLY LANDS SOMEWHERE.
  ///
  /// Two things happen, in this order and for this reason:
  ///   1. an UNREAD row is marked read first, and awaited. Marking read is the
  ///      behaviour this row already had and it is not being traded for
  ///      navigation — a parent who taps a row has seen it, whether or not the
  ///      destination turns out to have a screen. `NotificationsApi.markAsRead`
  ///      already enqueues on failure (offline queue), so the catch here is not
  ///      a swallow: the operation is durable and replays on reconnect.
  ///   2. THEN the tap is routed, from the link the SERVER resolved and put on
  ///      `data.deepLink`. `parseDeepLink` is total and `DeepLinkRouter.follow`
  ///      is total, so there is no tap that throws and no tap that does nothing
  ///      silently — a destination this app cannot open says so in a snackbar
  ///      and leaves the parent here, in the inbox, where the notification is.
  ///
  /// The list is refreshed LAST, after navigation has been asked for, so the
  /// unread dot clears without making the parent wait on a round trip before
  /// the screen moves.
  Future<void> _onNotificationTap(Map<String, dynamic> notification) async {
    final destination = parseDeepLink(deepLinkFromNotification(notification));
    final isUnread = notification['readAt'] == null;
    final id = notification['id'];

    if (isUnread && id is String) {
      try {
        await ref.read(notificationsApiProvider).markAsRead(id);
      } catch (_) {
        // Already enqueued by NotificationsApi — replayed on reconnect.
      }
    }
    if (!mounted) return;

    final t = ref.read(localeControllerProvider.notifier).t;
    DeepLinkRouter.follow(context, destination, t: t);

    if (isUnread) await _load();
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
      body: Column(
        children: [
          _permissionBanner(t),
          Expanded(child: _body(t, ref.watch(localeControllerProvider.notifier).isRtl)),
        ],
      ),
    );
  }

  /// G18 — the explanation, in the one place where the value is already visible.
  ///
  /// Shown ONLY when there is both something to gain and a dialog left to show:
  /// not when already granted, not when this build has no Firebase to deliver
  /// with, and not again after the parent has answered in this session.
  Widget _permissionBanner(String Function(String) t) {
    final state = _permissionState;
    final shouldShow = !_permissionAsked &&
        (state == ParentNotificationPermissionState.notRequested ||
            state == ParentNotificationPermissionState.denied);
    if (!shouldShow) return const SizedBox.shrink();

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.sage500.withOpacity(0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.sage500.withOpacity(0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.notifications_off_outlined, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  t('notifications.permTitle'),
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            t('notifications.permBody'),
            style: const TextStyle(fontSize: 14, height: 1.4),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: AlignmentDirectional.centerEnd,
            child: FilledButton(
              onPressed: _requestPermission,
              child: Text(t('notifications.permEnable')),
            ),
          ),
        ],
      ),
    );
  }

  Widget _body(String Function(String) t, bool arabic) {
    return _failure != null
          // THE LINE THE B3 ENVELOPE EXISTS FOR — the server's own Arabic
          // sentence, verbatim, with its requestId for a support ticket.
          ? Center(
              child: SingleChildScrollView(
                child: DsErrorState(
                  failure: _failure!,
                  title: t('common.error'),
                  retryLabel: t('common.retry'),
                  requestIdLabel: t('common.requestId'),
                  arabic: arabic,
                  onRetry: _load,
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
                              // EVERY row is tappable now, not just the unread
                              // ones: a read notification still has a
                              // destination, and a row that goes dead the
                              // moment it is read is the same no-op with an
                              // extra step.
                              onTap: () => _onNotificationTap(n),
                            ),
                          );
                        },
                      ),
                    );
  }
}
