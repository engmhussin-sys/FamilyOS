import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/localization/locale_controller.dart';
import '../../device_status/presentation/device_home_screen.dart';
import '../../family_growth/presentation/my_growth_screen.dart';
import 'my_progress_screen.dart';
import 'my_rewards_screen.dart';
import 'today_goals_screen.dart';

/// THE CHILD'S HOME — three tabs, and a coach instead of a console.
///
/// **THIS CLASS IS THE FIX FOR AUDIT PA-M-041 (🔴 High).**
///
/// BEFORE: `app.dart` → `_AppRoot` → `DeviceHomeScreen`. A paired child
/// opened the app and landed on «حالة الجهاز»: heartbeat, runtime status,
/// diagnostics, permissions, capabilities, memory usage, battery percent,
/// and a «زامن الإمكانيات دلوقتي» button — with «نموّي» and «جوايزي» as two
/// buttons in the middle of it. The audit's verdict: «هذا console مراقبة،
/// لا مدرّب … يخالف SURVEIL→COACH مباشرة، ويضرب الـ Wedge المعلن».
///
/// AFTER: `app.dart` lands here. Tab 1 is TODAY'S GOALS. Tab 2 is the
/// child's rewards. Tab 3 is their progress. `DeviceHomeScreen` is intact,
/// unmodified, and reachable from one small, low-contrast icon in the app
/// bar — the same place a phone puts settings.
///
/// NOTHING WAS DELETED. The permission checklist still exists and still
/// works, including the accessibility priming flow and the OEM autostart
/// step; a parent (or an older child) who needs it can still reach it in
/// one tap. What changed is which of the two things the product opens with,
/// and that is the entire finding.
class ChildHomeShell extends ConsumerStatefulWidget {
  const ChildHomeShell({super.key});

  @override
  ConsumerState<ChildHomeShell> createState() => _ChildHomeShellState();
}

class _ChildHomeShellState extends ConsumerState<ChildHomeShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    final titles = [t('today.title'), t('myRewards.title'), t('progress.title')];

    return Scaffold(
      appBar: AppBar(
        title: Text(titles[_index]),
        actions: [
          IconButton(
            icon: const Icon(Icons.auto_awesome_outlined),
            tooltip: t('shell.myGrowth'),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const MyGrowthScreen()),
            ),
          ),
          // THE DEMOTION, in one widget. Everything the child used to land
          // on is behind this icon: permissions, capabilities, diagnostics,
          // battery, memory, enforcement status.
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            tooltip: t('shell.deviceSettings'),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const DeviceHomeScreen()),
            ),
          ),
        ],
      ),
      body: IndexedStack(
        index: _index,
        children: const [
          TodayGoalsScreen(),
          MyRewardsScreen(),
          MyProgressScreen(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (value) => setState(() => _index = value),
        // 68px — above Material's default, matching KidTheme's commitment to
        // large targets for a young reader on a cheap phone.
        height: 68,
        destinations: [
          NavigationDestination(
            icon: const Icon(Icons.flag_outlined),
            selectedIcon: const Icon(Icons.flag_rounded, color: KidColor.primary),
            label: t('shell.today'),
          ),
          NavigationDestination(
            icon: const Icon(Icons.card_giftcard_outlined),
            selectedIcon: const Icon(Icons.card_giftcard_rounded, color: KidColor.primary),
            label: t('shell.rewards'),
          ),
          NavigationDestination(
            icon: const Icon(Icons.insights_outlined),
            selectedIcon: const Icon(Icons.insights_rounded, color: KidColor.primary),
            label: t('shell.progress'),
          ),
        ],
      ),
    );
  }
}
