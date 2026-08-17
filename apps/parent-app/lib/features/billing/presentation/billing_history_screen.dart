import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
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

  /// The B3 envelope rather than `e.toString()` — see [_load].
  ApiFailure? _failure;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _failure = null);
    try {
      final result = await ref.read(billingApiProvider).getBillingHistory();
      if (mounted) setState(() => _invoices = result);
    } catch (e) {
      // The server's own sentence, kept whole. A billing failure is the one a
      // parent is most likely to quote to support, which is also why the
      // requestId is rendered with it.
      if (mounted) setState(() => _failure = ApiFailure.from(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text(t('billingHistory.title'))),
      body: _failure != null
          ? Center(
              child: SingleChildScrollView(
                child: DsErrorState(
                  failure: _failure!,
                  title: t('common.error'),
                  retryLabel: t('common.retry'),
                  requestIdLabel: t('common.requestId'),
                  arabic: locale.isRtl,
                  onRetry: _load,
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

  /// `PAID` / `OPEN` / `DRAFT` / `VOID` / `UNCOLLECTIBLE` are the five values
  /// of the server's `InvoiceStatus` enum, and NONE of them is a sentence a
  /// parent should be shown. This chip used to render the raw value.
  ///
  /// The keys are written out as LITERALS rather than built with
  /// `t('invoiceStatus.$status')`, for the same reason
  /// `create_family_screen.dart` writes its country labels out: an
  /// interpolated key is invisible to `scripts/verify_l10n_parity.py`, so a
  /// missing Arabic translation would ship silently. An unrecognised value —
  /// a status this app has not been taught yet — falls back to a neutral
  /// «قيد المعالجة» line rather than leaking the code.
  String _statusLabel(String status) {
    final labels = <String, String>{
      'PAID': t('invoiceStatus.PAID'),
      'OPEN': t('invoiceStatus.OPEN'),
      'DRAFT': t('invoiceStatus.DRAFT'),
      'VOID': t('invoiceStatus.VOID'),
      'UNCOLLECTIBLE': t('invoiceStatus.UNCOLLECTIBLE'),
    };
    return labels[status] ?? t('invoiceStatus.unknown');
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
          child: Text(
            _statusLabel(status),
            style: TextStyle(color: color, fontWeight: FontWeight.w600, fontSize: 12),
          ),
        ),
      ),
    );
  }
}
