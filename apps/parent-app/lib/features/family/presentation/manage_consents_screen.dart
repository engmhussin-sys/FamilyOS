import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// Sprint 1 (Consent Enforcement, Option C) — the explicit REVOKE half
/// of "implicit grant at registration + explicit opt-out." Every
/// baseline consent type CreateChildScreen granted automatically is
/// individually toggleable here, at any time.
class ManageConsentsScreen extends ConsumerStatefulWidget {
  const ManageConsentsScreen({super.key});

  @override
  ConsumerState<ManageConsentsScreen> createState() => _ManageConsentsScreenState();
}

const _consentTypes = [
  'DATA_COLLECTION',
  'LOCATION_TRACKING',
  'APP_USAGE_MONITORING',
  'AI_BEHAVIOR_ANALYSIS',
  'KEYBOARD_BEHAVIOR_ANALYSIS',
  'HEALTH_DATA',
];

class _ManageConsentsScreenState extends ConsumerState<ManageConsentsScreen> {
  List<dynamic>? _children;
  String? _selectedChildId;
  Map<String, bool> _consentByType = {};
  bool _isLoading = true;
  String? _errorMessage;
  final Set<String> _savingTypes = {};

  @override
  void initState() {
    super.initState();
    _loadChildren();
  }

  Future<void> _loadChildren() async {
    try {
      final children = await ref.read(dashboardApiProvider).getChildren();
      if (!mounted) return;
      setState(() {
        _children = children;
        _selectedChildId = children.isNotEmpty ? (children.first as Map<String, dynamic>)['id'] as String : null;
      });
      if (_selectedChildId != null) await _loadConsents(_selectedChildId!);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _loadConsents(String childId) async {
    setState(() => _isLoading = true);
    try {
      final consents = await ref.read(consentApiProvider).listConsents(childId);
      final byType = <String, bool>{};
      for (final c in consents) {
        final map = c as Map<String, dynamic>;
        byType[map['consentType'] as String] = map['granted'] as bool;
      }
      if (mounted) setState(() => _consentByType = byType);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _toggle(String consentType, bool value) async {
    if (_selectedChildId == null) return;
    setState(() => _savingTypes.add(consentType));
    final previous = _consentByType[consentType] ?? false;
    setState(() => _consentByType[consentType] = value);
    try {
      await ref.read(consentApiProvider).setConsent(_selectedChildId!, consentType, value);
    } catch (_) {
      if (mounted) setState(() => _consentByType[consentType] = previous);
    } finally {
      if (mounted) setState(() => _savingTypes.remove(consentType));
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('consents.title'))),
      body: _errorMessage != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(t('common.error'), textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    FilledButton(onPressed: _loadChildren, child: Text(t('common.retry'))),
                  ],
                ),
              ),
            )
          : (_children == null || (_isLoading && _consentByType.isEmpty))
              ? const Center(child: CircularProgressIndicator())
              : _children!.isEmpty
                  ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(t('consents.noChildren'), textAlign: TextAlign.center)))
                  : ListView(
                      padding: const EdgeInsets.all(16),
                      children: [
                        if (_children!.length > 1)
                          DropdownButtonFormField<String>(
                            value: _selectedChildId,
                            decoration: InputDecoration(labelText: t('consents.selectChild')),
                            items: _children!
                                .map((c) => DropdownMenuItem(
                                      value: (c as Map<String, dynamic>)['id'] as String,
                                      child: Text(c['firstName'] as String),
                                    ))
                                .toList(),
                            onChanged: (value) {
                              if (value == null) return;
                              setState(() => _selectedChildId = value);
                              _loadConsents(value);
                            },
                          ),
                        const SizedBox(height: 16),
                        Text(t('consents.explanation'), style: Theme.of(context).textTheme.bodyMedium),
                        const SizedBox(height: 16),
                        ..._consentTypes.map((type) => _ConsentTile(
                              title: t('consents.type.$type.title'),
                              description: t('consents.type.$type.description'),
                              granted: _consentByType[type] ?? false,
                              isSaving: _savingTypes.contains(type),
                              onChanged: (value) => _toggle(type, value),
                            )),
                      ],
                    ),
    );
  }
}

class _ConsentTile extends StatelessWidget {
  const _ConsentTile({
    required this.title,
    required this.description,
    required this.granted,
    required this.isSaving,
    required this.onChanged,
  });

  final String title;
  final String description;
  final bool granted;
  final bool isSaving;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 2),
                  Text(description, style: Theme.of(context).textTheme.bodyMedium),
                ],
              ),
            ),
            if (isSaving)
              const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2))
            else
              Switch(value: granted, onChanged: onChanged, activeColor: AppTheme.sage500),
          ],
        ),
      ),
    );
  }
}
