import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
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
  String? _errorMessage;
  final Set<String> _processingIds = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(lifeIntelligenceApiProvider).getPendingMessages();
      if (mounted) setState(() => _pending = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  Future<void> _approve(String childId, String messageId) async {
    setState(() => _processingIds.add(messageId));
    try {
      await ref.read(lifeIntelligenceApiProvider).approveMessage(childId, messageId);
    } catch (_) {
      // Best-effort — the list reload below reflects the real current state either way.
    }
    await _load();
    if (mounted) setState(() => _processingIds.remove(messageId));
  }

  Future<void> _reject(String childId, String messageId) async {
    setState(() => _processingIds.add(messageId));
    try {
      await ref.read(lifeIntelligenceApiProvider).rejectMessage(childId, messageId);
    } catch (_) {
      // Best-effort.
    }
    await _load();
    if (mounted) setState(() => _processingIds.remove(messageId));
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('pendingApprovals.title'))),
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
          : _pending == null
              ? const Center(child: CircularProgressIndicator())
              : _pending!.isEmpty
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
                            category: message['category'] as String? ?? '',
                            isProcessing: isProcessing,
                            approveLabel: t('pendingApprovals.approve'),
                            rejectLabel: t('pendingApprovals.reject'),
                            onApprove: () => _approve(childId, messageId),
                            onReject: () => _reject(childId, messageId),
                          );
                        },
                      ),
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
