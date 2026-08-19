import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/authentication/application/auth_controller.dart';
import '../di/providers.dart';
import '../localization/locale_controller.dart';
import 'deep_link_channel.dart';
import 'deep_link_router.dart';

/// A LINK THAT ARRIVED BEFORE THERE WAS ANYWHERE TO PUT IT.
///
/// Set by [DeepLinkHost] whenever a link lands while this parent is not (yet)
/// authenticated — which is EVERY cold start, because the session check runs on
/// `SplashScreen` and has not finished at the moment the initial intent is
/// read. Drained in exactly one place: `DashboardHomeScreen.initState`, the
/// authenticated landing that both paths reach — splash → dashboard for a live
/// session, and login → dashboard for a fresh one.
///
/// ONE DRAIN SITE IS THE POINT. Following the link from the splash screen
/// instead would race its own `pushReplacementNamed`, which replaces the top
/// route — including a route the link had just pushed.
final pendingDeepLinkProvider = StateProvider<String?>((ref) => null);

/// THE ONE LISTENER FOR OS-DELIVERED `abny://` LINKS.
///
/// Mounted in `main.dart`'s `MaterialApp.builder`, so it lives for as long as
/// the app does and outlives every screen. It decides only WHEN a link is
/// followed; WHERE it lands is [DeepLinkRouter]'s, and what it means is
/// `parseDeepLink`'s. This widget adds no third opinion.
///
/// WHY IT IS NOT «follow it immediately, always». A deep link names a surface
/// behind the session — `abny://approvals` is a parent's queue — so following
/// one before the session is known would push a screen that immediately fires
/// unauthenticated requests, and on a cold start it would also race the splash
/// screen's own navigation. So: authenticated and a navigator in hand → follow
/// now; anything else → park it in [pendingDeepLinkProvider], which the
/// dashboard drains the moment it exists.
class DeepLinkHost extends ConsumerStatefulWidget {
  const DeepLinkHost({
    super.key,
    required this.navigatorKey,
    required this.child,
  });

  /// The app's navigator. Taken as an argument rather than read from a
  /// provider because `main.dart` already owns exactly one and this widget
  /// sits ABOVE the Navigator in the tree (it is installed by
  /// `MaterialApp.builder`), so `Navigator.of(context)` here would find
  /// nothing.
  final GlobalKey<NavigatorState> navigatorKey;

  final Widget child;

  @override
  ConsumerState<DeepLinkHost> createState() => _DeepLinkHostState();
}

class _DeepLinkHostState extends ConsumerState<DeepLinkHost> {
  @override
  void initState() {
    super.initState();
    // Warm starts first: `onNewIntent` can fire at any moment from here on.
    DeepLinkChannel.listen(_onLink);
    // The cold-start link, after the first frame — `ref.read` before the tree
    // is mounted is not allowed, and the navigator does not exist yet either.
    WidgetsBinding.instance.addPostFrameCallback((_) => _consumeInitialLink());
  }

  @override
  void dispose() {
    DeepLinkChannel.stopListening();
    super.dispose();
  }

  Future<void> _consumeInitialLink() async {
    final link = await DeepLinkChannel.consumeInitialLink();
    if (link == null) return;
    if (!mounted) return;
    _onLink(link);
  }

  /// TOTAL, like everything else on this path: a link either moves the app now
  /// or is parked for the dashboard. There is no branch that drops one.
  void _onLink(String link) {
    final status = ref.read(authControllerProvider).status;
    final navigatorContext = widget.navigatorKey.currentContext;
    if (status != AuthStatus.authenticated || navigatorContext == null) {
      ref.read(pendingDeepLinkProvider.notifier).state = link;
      return;
    }
    final t = ref.read(localeControllerProvider.notifier).t;
    DeepLinkRouter.followLink(navigatorContext, link, t: t);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
