import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/routing/app_routes.dart';

/// Sprint 6 (Support) — CLOSES A REAL GAP: zero support feature
/// existed anywhere in this product. Deliberately the minimum viable
/// version per the launch roadmap's own scoping: a static FAQ (no
/// backend needed, edited by shipping a new app version — acceptable
/// for a first pass' update cadence) plus a real contact form backed
/// by the new /support endpoint. No chat widget, no ticketing UI —
/// a real future upgrade once support volume justifies the
/// investment, not invented ahead of need.
class SupportHomeScreen extends ConsumerWidget {
  const SupportHomeScreen({super.key});

  static const List<({String questionKey, String answerKey})> _faqEntries = [
    (questionKey: 'support.faq.q1', answerKey: 'support.faq.a1'),
    (questionKey: 'support.faq.q2', answerKey: 'support.faq.a2'),
    (questionKey: 'support.faq.q3', answerKey: 'support.faq.a3'),
    (questionKey: 'support.faq.q4', answerKey: 'support.faq.a4'),
    (questionKey: 'support.faq.q5', answerKey: 'support.faq.a5'),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('support.title'))),
      body: ListView(
        padding: const EdgeInsets.all(DsSpace.lg),
        children: [
          Text(t('support.faqTitle'), style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: DsSpace.sm),
          ..._faqEntries.map((entry) => _FaqTile(question: t(entry.questionKey), answer: t(entry.answerKey))),
          const SizedBox(height: DsSpace.xl),
          Container(
            padding: const EdgeInsets.all(DsSpace.lg),
            decoration: BoxDecoration(color: AppTheme.sage500.withOpacity(0.08), borderRadius: BorderRadius.circular(DsRadius.card)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(t('support.stillNeedHelp'), style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: DsSpace.sm),
                Text(t('support.contactBody'), style: Theme.of(context).textTheme.bodyMedium),
                const SizedBox(height: DsSpace.lg),
                FilledButton.icon(
                  onPressed: () => Navigator.of(context).pushNamed(AppRoutes.contactSupport),
                  icon: const Icon(Icons.mail_outline_rounded),
                  label: Text(t('support.contactButton')),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FaqTile extends StatelessWidget {
  const _FaqTile({required this.question, required this.answer});

  final String question;
  final String answer;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: DsSpace.sm),
      child: ExpansionTile(
        title: Text(question, style: Theme.of(context).textTheme.titleMedium),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: Text(answer, style: Theme.of(context).textTheme.bodyMedium),
            ),
          ),
        ],
      ),
    );
  }
}
