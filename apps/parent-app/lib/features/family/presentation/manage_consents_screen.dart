import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';
import '../data/child_profile_repository.dart';

/// Sprint 1 (Consent Enforcement, Option C) — the explicit REVOKE half
/// of "implicit grant at registration + explicit opt-out." Every
/// baseline consent type CreateChildScreen granted automatically is
/// individually toggleable here, at any time.
///
/// ERROR PASS — THE LATENT VERSION OF THE SAME BUG. Both `catch` blocks
/// here ended with `_errorMessage = e.toString()`, and the error branch
/// then rendered `t('common.error')` and ignored the field. So the raw
/// transport sentence was never on screen — it was one `Text(_errorMessage!)`
/// away from being, at every moment, and that exact line has shipped in this
/// repository before. Meanwhile the server's own `messageAr` was thrown away
/// and every failure, from «ليس لديك صلاحية» to a dropped socket, collapsed
/// into one «حدث خطأ ما.» that told the parent nothing.
///
/// Both paths now hold an [ApiFailure] and render it through the shared
/// `DsErrorState`, which shows the server's sentence under this screen's own
/// chrome line and keeps the Retry the screen already had. The toggle's
/// optimistic revert is UNCHANGED — it still snaps the switch back — but the
/// error behind it now reaches the crash reporter instead of being dropped
/// by a bare `catch (_)`.
///
/// The three casts inside the load loop are gone too: they moved into
/// [ChildProfileRepository], where a row the client cannot read is dropped
/// rather than turned into a `TypeError` that this screen would have
/// displayed as raw text.
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
  List<ChildSummary>? _children;
  String? _selectedChildId;
  Map<String, bool> _consentByType = {};
  bool _isLoading = true;

  /// The B3 envelope, not `e.toString()`. Its `diagnostic` still holds the
  /// original transport text; no widget on this screen reads that field.
  ApiFailure? _failure;
  final Set<String> _savingTypes = {};

  @override
  void initState() {
    super.initState();
    _loadChildren();
  }

  Future<void> _loadChildren() async {
    setState(() => _failure = null);
    try {
      final children = await ref.read(childProfileRepositoryProvider).listChildren();
      if (!mounted) return;
      setState(() {
        _children = children;
        _selectedChildId = children.isNotEmpty ? children.first.id : null;
      });
      if (_selectedChildId != null) await _loadConsents(_selectedChildId!);
    } catch (error) {
      // The repository throws `ApiFailure` and has already logged the
      // original with its stack.
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _loadConsents(String childId) async {
    setState(() => _isLoading = true);
    try {
      final consents = await ref.read(childProfileRepositoryProvider).listConsents(childId);
      final byType = <String, bool>{
        for (final consent in consents) consent.consentType: consent.granted,
      };
      if (mounted) setState(() => _consentByType = byType);
    } catch (error) {
      if (mounted) setState(() => _failure = ApiFailure.from(error));
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
      await ref
          .read(childProfileRepositoryProvider)
          .setConsent(_selectedChildId!, consentType, value);
    } catch (_) {
      // THE REVERT IS DELIBERATE AND UNCHANGED: the switch shows what the
      // SERVER holds, so a write that did not land must not leave the UI
      // claiming it did. What changed is underneath — this used to be the
      // only failure in the app that vanished completely, and the repository
      // now hands the original and its stack to the crash reporter before
      // this `catch` ever runs.
      //
      // It does not raise `_failure`: that field drives the whole-screen
      // error state with its Retry, and replacing a loaded consent list with
      // an error page because one toggle did not save would hide the other
      // five rows the parent can still act on.
      if (mounted) setState(() => _consentByType[consentType] = previous);
    } finally {
      if (mounted) setState(() => _savingTypes.remove(consentType));
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text(t('consents.title'))),
      body: _failure != null
          ? Center(
              child: DsErrorState(
                failure: _failure!,
                title: t('consents.loadFailedTitle'),
                retryLabel: t('common.retry'),
                requestIdLabel: t('common.requestId'),
                arabic: locale.isRtl,
                // The same Retry this screen already had, on the same call.
                onRetry: _loadChildren,
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
                                .map((child) => DropdownMenuItem(
                                      value: child.id,
                                      // A child row with no first name used
                                      // to throw inside `build` — a red
                                      // screen with a stack trace on it.
                                      child: Text(
                                        child.firstName.isEmpty
                                            ? t('createChild.unnamedChild')
                                            : child.firstName,
                                      ),
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
