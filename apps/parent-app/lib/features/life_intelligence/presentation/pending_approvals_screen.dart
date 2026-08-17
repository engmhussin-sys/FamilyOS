import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// CLOSES A CRITICAL REAL GAP discovered while reviewing the Child
/// App's Notification path: FamilyCommunicationService.approve()/
/// reject() existed since an earlier sprint, but NOTHING ever
/// surfaced which messages needed approving — every Smart
/// Notification targeted at a child (built across Sprint 16-16.2:
/// STREAK_ACHIEVED, BADGE_EARNED, HYDRATION_REMINDER, etc.) is
/// created PENDING via draftAiMessage and was structurally
/// unreachable without a parent ever seeing it in the first place.
/// This screen is that missing piece — the read+action UI for the
/// backend's own pre-existing endpoint
/// (GET /life-intelligence/communication/pending).
class PendingApprovalsScreen extends ConsumerStatefulWidget {
  const PendingApprovalsScreen({super.key});

  @override
  ConsumerState<PendingApprovalsScreen> createState() => _PendingApprovalsScreenState();
}

class _PendingApprovalsScreenState extends ConsumerState<PendingApprovalsScreen> {
  List<dynamic>? _pending;
  ApiFailure? _failure;

  /// A refused approve/reject. Distinct from [_failure] on purpose: the
  /// queue itself is still readable and still shows every other decision
  /// waiting — losing that because one row was refused would be worse than
  /// the refusal. A 409 here usually means the message was already decided
  /// elsewhere, and the server says so in Arabic.
  ApiFailure? _actionFailure;

  final Set<String> _processingIds = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _failure = null);
    try {
      final result = await ref.read(lifeIntelligenceRepositoryProvider).getPendingMessages();
      if (mounted) setState(() => _pending = result);
    } catch (error) {
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    }
  }

  Future<void> _approve(String childId, String messageId) async {
    await _decide(messageId, () => ref
        .read(lifeIntelligenceRepositoryProvider)
        .approveMessage(childId, messageId));
  }

  Future<void> _reject(String childId, String messageId) async {
    await _decide(messageId, () => ref
        .read(lifeIntelligenceRepositoryProvider)
        .rejectMessage(childId, messageId));
  }

  /// Approve and reject differ only in which call they make, and both used
  /// to end in `catch (_) {}`. The reload afterwards then made a refusal
  /// look exactly like a success — the row stayed in the list and nothing
  /// said why. The reload is KEPT (the server, not this screen, decides what
  /// is still pending); what is added is the sentence explaining it.
  Future<void> _decide(String messageId, Future<void> Function() call) async {
    setState(() {
      _processingIds.add(messageId);
      _actionFailure = null;
    });
    try {
      await call();
    } catch (error) {
      if (mounted) setState(() => _actionFailure = ApiFailure.from(error));
    }
    await _load();
    if (mounted) setState(() => _processingIds.remove(messageId));
  }

  /// A CHILD-targeted message's `category` is a backend notification type —
  /// `STREAK_ACHIEVED`, `HYDRATION_REMINDER`, `REWARD_GRANTED_CHILD`. It was
  /// printed verbatim on the card, so an Arabic-first screen showed a parent
  /// a SCREAMING_SNAKE_CASE English token. Known types get their label; a
  /// type this build predates gets the neutral «رسالة» rather than the raw
  /// value, because the backend's vocabulary grows on its own schedule.
  String _categoryLabel(LocaleController locale, Object? raw) {
    final value = raw is String ? raw.trim() : '';
    final key = 'messageCategory.$value';
    if (value.isNotEmpty && locale.has(key)) return locale.t(key);
    return locale.t('messageCategory.other');
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text(t('pendingApprovals.title'))),
      body: _failure != null
          ? Center(
              child: DsErrorState(
                failure: _failure!,
                title: t('common.error'),
                retryLabel: t('common.retry'),
                requestIdLabel: t('common.requestId'),
                arabic: locale.isRtl,
                onRetry: _load,
              ),
            )
          : _pending == null
              ? const Center(child: CircularProgressIndicator())
              : Column(
                  children: [
                    if (_actionFailure != null)
                      DsErrorState(
                        failure: _actionFailure!,
                        title: t('lifeIntelligence.actionFailedTitle'),
                        retryLabel: t('common.dismiss'),
                        requestIdLabel: t('common.requestId'),
                        arabic: locale.isRtl,
                        compact: true,
                        onRetry: () => setState(() => _actionFailure = null),
                      ),
                    Expanded(
                      child: _pending!.isEmpty
                          ? Center(
                              child: Padding(
                                padding: const EdgeInsets.all(32),
                                child: Text(t('pendingApprovals.empty'), textAlign: TextAlign.center),
                              ),
                            )
                          : RefreshIndicator(
                              onRefresh: _load,
                              child: ListView.builder(
                                padding: const EdgeInsets.all(16),
                                itemCount: _pending!.length,
                                itemBuilder: (context, index) {
                                  final message = _pending![index] as Map<String, dynamic>;
                                  final messageId = message['id'] as String;
                                  final childId = message['childId'] as String;
                                  final childName = message['childName'] as String? ?? '';
                                  final isProcessing = _processingIds.contains(messageId);

                                  return _PendingMessageCard(
                                    title: message['title'] as String? ?? '',
                                    body: message['body'] as String? ?? '',
                                    childName: childName,
                                    category: _categoryLabel(locale, message['category']),
                                    isProcessing: isProcessing,
                                    approveLabel: t('pendingApprovals.approve'),
                                    rejectLabel: t('pendingApprovals.reject'),
                                    onApprove: () => _approve(childId, messageId),
                                    onReject: () => _reject(childId, messageId),
                                  );
                                },
                              ),
                            ),
                    ),
                  ],
                ),
    );
  }
}

class _PendingMessageCard extends StatelessWidget {
  const _PendingMessageCard({
    required this.title,
    required this.body,
    required this.childName,
    required this.category,
    required this.isProcessing,
    required this.approveLabel,
    required this.rejectLabel,
    required this.onApprove,
    required this.onReject,
  });

  final String title;
  final String body;
  final String childName;
  final String category;
  final bool isProcessing;
  final String approveLabel;
  final String rejectLabel;
  final VoidCallback onApprove;
  final VoidCallback onReject;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(color: AppTheme.guardian950.withOpacity(0.08), borderRadius: BorderRadius.circular(8)),
                  child: Text(childName, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                ),
                const SizedBox(width: 8),
                Text(category, style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
              ],
            ),
            const SizedBox(height: 10),
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(body, style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: 12),
            if (isProcessing)
              const Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))
            else
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: onReject,
                      style: OutlinedButton.styleFrom(foregroundColor: AppTheme.brick500),
                      child: Text(rejectLabel),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      onPressed: onApprove,
                      style: FilledButton.styleFrom(backgroundColor: AppTheme.sage500),
                      child: Text(approveLabel),
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
