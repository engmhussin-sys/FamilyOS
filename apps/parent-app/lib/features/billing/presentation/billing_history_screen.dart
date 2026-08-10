import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// CLOSES SPRINT 2's remaining piece: `/billing/history` (real,
/// already-built endpoint since Sprint 8) had zero UI consumer until
/// now — a parent had no way to see past invoices at all.
class BillingHistoryScreen extends ConsumerStatefulWidget {
  const BillingHistoryScreen({super.key});

  @override
  ConsumerState<BillingHistoryScreen> createState() => _BillingHistoryScreenState();
}

class _BillingHistoryScreenState extends ConsumerState<BillingHistoryScreen> {
  List<dynamic>? _invoices;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(billingApiProvider).getBillingHistory();
      if (mounted) setState(() => _invoices = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('billingHistory.title'))),
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
          : _invoices == null
              ? const Center(child: CircularProgressIndicator())
              : _invoices!.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(t('billingHistory.empty'), textAlign: TextAlign.center),
                      ),
                    )
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _invoices!.length,
                        itemBuilder: (context, index) {
                          final invoice = _invoices![index] as Map<String, dynamic>;
                          return _InvoiceRow(invoice: invoice, t: t);
                        },
                      ),
                    ),
    );
  }
}

class _InvoiceRow extends StatelessWidget {
  const _InvoiceRow({required this.invoice, required this.t});

  final Map<String, dynamic> invoice;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  Color _statusColor(String status) {
    switch (status) {
      case 'PAID':
        return AppTheme.sage500;
      case 'OPEN':
      case 'DRAFT':
        return AppTheme.amber500;
      case 'UNCOLLECTIBLE':
      case 'VOID':
        return AppTheme.brick500;
      default:
        return Colors.grey;
    }
  }

  String _formatDate(String? iso) {
    if (iso == null) return '';
    final date = DateTime.tryParse(iso);
    if (date == null) return '';
    return '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final amountCents = invoice['amountCents'] as int;
    final currency = invoice['currency'] as String;
    final status = invoice['status'] as String;
    final color = _statusColor(status);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(color: color.withOpacity(0.14), shape: BoxShape.circle),
          child: Icon(Icons.receipt_long_rounded, color: color, size: 20),
        ),
        title: Text('${(amountCents / 100).toStringAsFixed(2)} $currency'),
        subtitle: Text(_formatDate(invoice['issuedAt'] as String?)),
        trailing: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(color: color.withOpacity(0.14), borderRadius: BorderRadius.circular(20)),
          child: Text(status, style: TextStyle(color: color, fontWeight: FontWeight.w600, fontSize: 12)),
        ),
      ),
    );
  }
}
