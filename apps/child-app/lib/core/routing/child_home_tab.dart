import 'package:flutter_riverpod/flutter_riverpod.dart';

/// WHICH TAB THE CHILD'S HOME IS SHOWING — and the reason this is a provider
/// rather than a field.
///
/// `ChildHomeShell` used to own the selected tab as private `int _index` state.
/// That is the right shape for a shell nobody else talks to, and the wrong one
/// the moment a notification tap has to say «open the rewards tab»: the only
/// ways into a private field from outside are a `GlobalKey` reaching into a
/// `State`, or a second navigation system that pushes `MyRewardsScreen` on top
/// of the shell — which would show the child a rewards screen with no bottom
/// bar, and a back button where their tabs used to be.
///
/// So the tab moved one layer out, into the state system this app already
/// uses. The shell WATCHES it and the bottom bar WRITES it, exactly as before;
/// the deep-link router writes the same one value, and there is still precisely
/// one place that knows which tab is showing.
///
/// THE ENUM ORDER IS THE TAB ORDER. `NavigationBar` speaks in `int`, so
/// [ChildHomeTab.index] is the bar's `selectedIndex` and `ChildHomeTab.values`
/// is its destination list — one ordering, declared once, instead of a switch
/// that can disagree with the widget below it.
enum ChildHomeTab {
  /// أهداف النهاردة — the child's landing tab, and the safe default for any
  /// destination this app cannot open more precisely.
  today,

  /// جوايزي
  rewards,

  /// تقدّمي
  progress,

  /// المدرّب
  coach,
}

/// The selected tab. `today` on a cold start, which is the same tab the shell
/// opened on before this provider existed.
final childHomeTabProvider =
    StateProvider<ChildHomeTab>((ref) => ChildHomeTab.today);

/// The tab for a bar index. Out-of-range degrades to [ChildHomeTab.today]
/// rather than throwing — a `RangeError` raised from a tap handler is a crash
/// in a child's hand, and there is no index worth that.
ChildHomeTab childHomeTabFromIndex(int index) =>
    index >= 0 && index < ChildHomeTab.values.length
        ? ChildHomeTab.values[index]
        : ChildHomeTab.today;
