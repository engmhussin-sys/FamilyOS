import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: the pairing code — the single most important piece of
/// text on this screen, since it must be typed correctly into another
/// device — was a plain headline on a plain white card. Now a real
/// hero card with high-contrast spaced digits and a visual countdown
/// bar instead of a small text timer easy to miss.
class AddChildScreen extends ConsumerStatefulWidget {
  const AddChildScreen({super.key});

  @override
  ConsumerState<AddChildScreen> createState() => _AddChildScreenState();
}

class _AddChildScreenState extends ConsumerState<AddChildScreen> {
  List<dynamic>? _children;
  String? _selectedChildId;
  String? _code;
  int _secondsLeft = 0;
  int _totalSeconds = 1;
  Timer? _timer;
  bool _isGenerating = false;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _loadChildren();
  }

  Future<void> _loadChildren() async {
    final children = await ref.read(dashboardApiProvider).getChildren();
    if (!mounted) return;
    setState(() {
      _children = children;
      _selectedChildId = children.isNotEmpty ? children.first['id'] as String : null;
    });
  }

  Future<void> _generateCode() async {
    if (_selectedChildId == null) return;
    setState(() {
      _isGenerating = true;
      _errorMessage = null;
    });

    try {
      final result = await ref.read(pairingApiProvider).generateInviteCode(_selectedChildId!);
      if (!mounted) return;
      setState(() {
        _code = result['code'] as String;
        _secondsLeft = result['expiresInSeconds'] as int;
        _totalSeconds = _secondsLeft > 0 ? _secondsLeft : 1;
      });
      _startCountdown();
    } catch (e) {
      setState(() => _errorMessage = e.toString());
    } finally {
      if (mounted) setState(() => _isGenerating = false);
    }
  }

  void _startCountdown() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_secondsLeft <= 0) {
        timer.cancel();
        return;
      }
      setState(() => _secondsLeft--);
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('pairing.addChildTitle'))),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_children == null)
              const Center(child: CircularProgressIndicator())
            else if (_children!.isEmpty)
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    children: [
                      Icon(Icons.child_care_rounded, size: 48, color: AppTheme.guardian950.withOpacity(0.3)),
                      const SizedBox(height: 12),
                      Text(t('pairing.noChildrenYet'), textAlign: TextAlign.center),
                    ],
                  ),
                ),
              )
            else ...[
              DropdownButtonFormField<String>(
                value: _selectedChildId,
                decoration: InputDecoration(labelText: t('pairing.selectChild'), prefixIcon: const Icon(Icons.child_care_rounded)),
                items: _children!
                    .map((c) => DropdownMenuItem(value: c['id'] as String, child: Text(c['firstName'] as String)))
                    .toList(),
                onChanged: (value) => setState(() => _selectedChildId = value),
              ),
              const SizedBox(height: 24),
              if (_code == null || _secondsLeft <= 0)
                FilledButton.icon(
                  onPressed: _isGenerating ? null : _generateCode,
                  icon: _isGenerating ? null : const Icon(Icons.qr_code_2_rounded),
                  label: _isGenerating
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Text(t('pairing.generateCode')),
                )
              else
                Container(
                  padding: const EdgeInsets.all(28),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [AppTheme.guardian950, AppTheme.guardian950.withOpacity(0.85)],
                    ),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Column(
                    children: [
                      Text(
                        _code!,
                        style: Theme.of(context).textTheme.displaySmall?.copyWith(color: Colors.white, letterSpacing: 6, fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 16),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: LinearProgressIndicator(
                          value: _secondsLeft / _totalSeconds,
                          minHeight: 6,
                          backgroundColor: Colors.white.withOpacity(0.15),
                          valueColor: const AlwaysStoppedAnimation(AppTheme.amber500),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        '${t('pairing.validFor')} ${_secondsLeft ~/ 60}:${(_secondsLeft % 60).toString().padLeft(2, '0')}',
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white70),
                      ),
                    ],
                  ),
                ),
              if (_errorMessage != null) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: AppTheme.brick500.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
                  child: Row(
                    children: [
                      const Icon(Icons.error_outline_rounded, color: AppTheme.brick500, size: 18),
                      const SizedBox(width: 8),
                      Expanded(child: Text(_errorMessage!, style: const TextStyle(color: AppTheme.brick500))),
                    ],
                  ),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
