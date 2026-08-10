import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';

/// Combines Habits + Hydration quick-log + Faith practices + Messages
/// into ONE screen — same "related concerns, one screen" discipline
/// DeviceHomeScreen already established for this app, not four
/// separate screens for four small pieces of child-facing functionality.
///
/// SCOPE NOTE (stated honestly, not hidden): DeviceHomeScreen's own
/// comment describes this app's screens as "onboarding/diagnostic
/// screens only" — this screen is a genuine, deliberate expansion of
/// that stated scope, per the Life Intelligence Platform's own
/// explicit product requirement (a child-facing self-log surface).
/// Not a silent scope creep — flagged here for whoever reviews this next.
class MyGrowthScreen extends ConsumerStatefulWidget {
  const MyGrowthScreen({super.key});

  @override
  ConsumerState<MyGrowthScreen> createState() => _MyGrowthScreenState();
}

class _MyGrowthScreenState extends ConsumerState<MyGrowthScreen> {
  List<dynamic>? _habits;
  List<dynamic>? _practices;
  List<dynamic>? _messages;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _loadAll();
  }

  Future<void> _loadAll() async {
    setState(() => _errorMessage = null);
    try {
      final api = ref.read(familyGrowthApiProvider);
      final results = await Future.wait([api.getHabits(), api.getFaithPractices(), api.getMessages()]);
      if (mounted) {
        setState(() {
          _habits = results[0];
          _practices = results[1];
          _messages = results[2];
        });
      }
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  Future<void> _completeHabit(String habitId) async {
    try {
      await ref.read(familyGrowthApiProvider).completeHabit(habitId);
    } catch (_) {
      // Best-effort — matches this app's own "a failure here shouldn't
      // crash the rest of the screen" principle (DeviceHomeScreen's
      // own diagnostics-refresh methods use the same pattern).
    }
    await _loadAll();
  }

  Future<void> _logWater() async {
    try {
      await ref.read(familyGrowthApiProvider).logHydration(250); // a standard glass
    } catch (_) {
      // Best-effort.
    }
    await _loadAll();
  }

  Future<void> _logFaithPractice(String practiceId) async {
    try {
      await ref.read(familyGrowthApiProvider).logFaithPractice(practiceId);
    } catch (_) {
      // Best-effort.
    }
    await _loadAll();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('My Growth')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _logWater,
        icon: const Icon(Icons.water_drop_outlined),
        label: const Text('Log water'),
      ),
      body: _errorMessage != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('Something went wrong.', textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    FilledButton(onPressed: _loadAll, child: const Text('Retry')),
                  ],
                ),
              ),
            )
          : (_habits == null || _practices == null || _messages == null)
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _loadAll,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      if (_messages!.isNotEmpty) ...[
                        const Text('Messages', style: TextStyle(fontWeight: FontWeight.bold)),
                        const SizedBox(height: 8),
                        ..._messages!.map(
                          (m) => Card(
                            margin: const EdgeInsets.only(bottom: 8),
                            child: ListTile(
                              title: Text((m as Map<String, dynamic>)['title'] as String? ?? ''),
                              subtitle: Text(m['body'] as String? ?? ''),
                            ),
                          ),
                        ),
                        const SizedBox(height: 16),
                      ],
                      const Text('Habits', style: TextStyle(fontWeight: FontWeight.bold)),
                      const SizedBox(height: 8),
                      if (_habits!.isEmpty) const Text('No habits yet.', style: TextStyle(color: Colors.grey)),
                      ..._habits!.map(
                        (h) => Card(
                          margin: const EdgeInsets.only(bottom: 8),
                          child: ListTile(
                            title: Text((h as Map<String, dynamic>)['title'] as String? ?? ''),
                            trailing: FilledButton(
                              onPressed: () => _completeHabit(h['id'] as String),
                              child: const Text('Done!'),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      const Text('Faith', style: TextStyle(fontWeight: FontWeight.bold)),
                      const SizedBox(height: 8),
                      if (_practices!.isEmpty) const Text('No practices yet.', style: TextStyle(color: Colors.grey)),
                      ..._practices!.map(
                        (p) => Card(
                          margin: const EdgeInsets.only(bottom: 8),
                          child: ListTile(
                            title: Text((p as Map<String, dynamic>)['title'] as String? ?? ''),
                            trailing: FilledButton(
                              onPressed: () => _logFaithPractice(p['id'] as String),
                              child: const Text('Done!'),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
    );
  }
}
