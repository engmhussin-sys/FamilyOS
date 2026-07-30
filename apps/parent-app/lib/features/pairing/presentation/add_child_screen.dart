import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

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
    ref.watch(localeControllerProvider); // registers rebuild dependency — see fix note below
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
              // PRODUCTION READINESS REVIEW FIX (UI/UX Review — Empty
              // State): previously fell through to a
              // DropdownButtonFormField with zero items and a
              // Generate-Code button the user could still tap with
              // `_selectedChildId == null`, calling the pairing API
              // with a null childId. Now explicitly explains there's
              // nothing to pair yet.
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(t('pairing.noChildrenYet'), textAlign: TextAlign.center),
                ),
              )
            else ...[
              DropdownButtonFormField<String>(
                value: _selectedChildId,
                decoration: InputDecoration(labelText: t('pairing.selectChild')),
                items: _children!
                    .map((c) => DropdownMenuItem(value: c['id'] as String, child: Text(c['firstName'] as String)))
                    .toList(),
                onChanged: (value) => setState(() => _selectedChildId = value),
              ),
              const SizedBox(height: 24),
              if (_code == null || _secondsLeft <= 0)
                FilledButton(
                  onPressed: _isGenerating ? null : _generateCode,
                  child: _isGenerating
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : Text(t('pairing.generateCode')),
                )
              else
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      children: [
                        Text(
                          _code!,
                          style: Theme.of(context).textTheme.headlineMedium?.copyWith(letterSpacing: 4),
                        ),
                        const SizedBox(height: 8),
                        Text('${t('pairing.validFor')} ${_secondsLeft ~/ 60}:${(_secondsLeft % 60).toString().padLeft(2, '0')}'),
                      ],
                    ),
                  ),
                ),
              if (_errorMessage != null) ...[
                const SizedBox(height: 12),
                Text(_errorMessage!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
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
