import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../family/presentation/child_detail_screen.dart';
import '../domain/safety_event.dart';

/// THE PARENT'S SAFETY & PROTECTION SURFACE — the screen `abny://safety/<id>`
/// points at.
///
/// IT IS NO LONGER THE DESTINATION OF `abny://screen-time`, and this comment
/// used to say it was. That was true only because the parent app had no
/// screen-time screen at all: `features/screen_time/` did not exist, while the
/// backend had been serving a complete Screen Time API for several sprints, so
/// a link named `screen-time` landed here as the best available answer to a
/// missing screen. It now resolves to `ScreenTimeChildrenScreen` — see
/// `deep_link_router.dart`'s header for the full argument, including what this
/// screen does NOT lose by it (`abny://safety/<alertId>` still opens it with
/// the alert selected, `AppRoutes.safety` is still registered, and the
/// dashboard still links here).
///
/// WHAT WAS MISSING, MEASURED. Four notification types reach a parent today —
/// `PROTECTION_BYPASS_ATTEMPT`, `ACCESSIBILITY_DISABLED`, `POLICY_VIOLATION`
/// and `CHILD_WELLBEING_CHECKIN` — and a tap on any of them landed in the
/// inbox, because no safety screen existed. The last of those is the
/// distress-escalation alert (`ai-core/application/services/distress-escalation.service.ts`),
/// which is the single most important notification this product sends, and it
/// had nowhere to go.
///
/// ---------------------------------------------------------------------------
/// THE ROUTE IT CONSUMES, AND THE ONE IT DELIBERATELY DOES NOT.
///
/// `GET /notifications` — `NotificationsController.list`
/// (`apps/backend/src/modules/notifications/presentation/controllers/notifications.controller.ts:14`),
/// `@ParentSurface()`, user-scoped — read through the inbox's own
/// `NotificationsApi.list()`. The safety-class filter is the server's own
/// classification transcribed into [SafetyEventTypes]; see that file for why
/// `GET /pairing/alerts` (`pairing.controller.ts:204`) is a strict SUBSET of
/// this route and would have missed the wellbeing check-in entirely.
///
/// NO ENDPOINT IS INVENTED. There is no parent-facing route that serves the
/// `AiAlert` model — it is read only by `analytics/application/growth-alerts.service.ts`,
/// an operator surface — so nothing here pretends to open an `AiAlert` row.
///
/// ---------------------------------------------------------------------------
/// WHAT [alertId] MEANS, STATED HONESTLY. `abny://safety/<alertId>` is LIVE
/// CODE on the server and is NOT EMITTED TODAY: `safetyDestination` in
/// `notification-destination.ts` interpolates `facts.alertId`, and no producer
/// carries one, so every one of the four alerts currently degrades to the
/// id-less `abny://screen-time` — which, since that link was retargeted, no
/// longer lands here. Those four taps reach the inbox (where the alert's own
/// text is) or the screen-time surface (where a parent can act); this screen is
/// reached from the dashboard and from an id-bearing link. When an id does
/// start arriving, the only alert
/// row a parent can read is the notification itself, so [alertId] is matched
/// against `notifications.id`. If it matches nothing — an old alert that has
/// scrolled past the server's 100-row window, or an id from a different
/// table — the screen says so calmly and still shows the recent list. It never
/// shows an empty page and never claims the event did not happen.
///
/// ---------------------------------------------------------------------------
/// THE COPY RULES, BECAUSE THIS IS THE SCREEN WHERE THEY MATTER MOST.
///
///   * `title` and `body` are SERVER-AUTHORED and render VERBATIM, never
///     through `t()`. They are the only text here that describes what happened.
///   * `type` NEVER reaches the screen. It selects a localised label and a
///     band; a parent must never read `PROTECTION_BYPASS_ATTEMPT`.
///   * `priority` is never read at all. Its vocabulary is `CRITICAL`/`HIGH`,
///     which is a database value, and its meaning is loudness rather than
///     urgency. The band comes from the type, mirroring the server's own
///     quiet-hours classification.
///   * `data` is never read. It carries a device-supplied `metadata` object
///     nobody has enumerated, and on the distress path the server deliberately
///     sends NO payload and a GENERIC sentence precisely so a child's own words
///     never reach a parent's screen. This screen does not undo that.
///   * Every app-authored line names what happened, when, and what the parent
///     can do — and none of them raises the temperature. A safety screen that
///     alarms for its own sake gets closed.
class SafetyScreen extends ConsumerWidget {
  const SafetyScreen({super.key, this.alertId});

  /// The alert a link named, or `null` for the surface itself. Opaque, bounded
  /// and never an authorization claim — it selects which card is shown first,
  /// and nothing else.
  final String? alertId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(safetyControllerProvider);
    final controller = ref.read(safetyControllerProvider.notifier);

    // EMPTY MEANS TWO DIFFERENT THINGS AND MUST NOT READ AS ONE. Arriving at
    // the surface with nothing in it is reassurance — «no alert has come
    // through». Arriving from a LINK that named an alert and finding nothing is
    // the opposite: an alert certainly happened, and «no alerts» would tell a
    // parent it did not. The list-level case is handled inside `_SafetyList`;
    // this is the same statement for the case where the whole feed is empty.
    final followedALink = alertId != null;

    return Scaffold(
      appBar: AppBar(title: Text(t('safety.title'))),
      body: RefreshIndicator(
        onRefresh: controller.load,
        child: DsStateView<List<SafetyEvent>>(
          state: state.events,
          arabic: locale.isRtl,
          loadingLabel: t('common.loading'),
          emptyTitle:
              followedALink ? t('safety.notInRecentTitle') : t('safety.emptyTitle'),
          emptyBody: followedALink ? t('safety.notInRecent') : t('safety.emptyBody'),
          emptyIcon:
              followedALink ? Icons.history_rounded : Icons.verified_user_outlined,
          errorTitle: t('safety.errorTitle'),
          retryLabel: t('common.retry'),
          requestIdLabel: t('common.requestId'),
          onRetry: controller.load,
          builder: (context, events) => _SafetyList(
            events: events,
            childNames: state.childNames,
            alertId: alertId,
          ),
        ),
      ),
    );
  }
}

/// WHERE THE LINKED ALERT GOES IN THE LIST. Two pure functions, public for the
/// same reason `DeepLinkRouter.resolve` is pure: the whole "a link named this
/// one" rule is then assertable without pumping a widget.
class SafetyScreenOrdering {
  const SafetyScreenOrdering._();

  /// The event a link named, or `null` when no link named one — or when the one
  /// it named is not in the window the server returned.
  static SafetyEvent? focusedIn(List<SafetyEvent> events, String? alertId) {
    if (alertId == null) return null;
    for (final event in events) {
      if (event.id == alertId) return event;
    }
    return null;
  }

  /// [focused] first, then everything else in the order the server sent it
  /// (`createdAt desc`). Nothing is re-sorted and NOTHING IS HIDDEN: a parent
  /// who followed a link sees that event at the top AND the rest underneath,
  /// because one alert is rarely the whole story.
  static List<SafetyEvent> ordered(List<SafetyEvent> events, SafetyEvent? focused) {
    if (focused == null) return events;
    final rest = events.where((event) => event.id != focused.id).toList(growable: false);
    return <SafetyEvent>[focused, ...rest];
  }
}

class _SafetyList extends ConsumerWidget {
  const _SafetyList({
    required this.events,
    required this.childNames,
    required this.alertId,
  });

  final List<SafetyEvent> events;
  final Map<String, String> childNames;
  final String? alertId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;
    final focused = SafetyScreenOrdering.focusedIn(events, alertId);
    final rows = SafetyScreenOrdering.ordered(events, focused);
    final askedForOneWeCannotFind = alertId != null && focused == null;

    return ListView(
      padding: DsSpace.screen,
      children: [
        DsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(t('safety.introTitle'), style: DsText.cardTitle(context)),
              DsSpace.gapXs,
              Text(t('safety.introBody'), style: DsText.caption(context)),
            ],
          ),
        ),
        if (askedForOneWeCannotFind)
          DsCard(
            accent: DsColor.statePending,
            child: Row(
              children: [
                Icon(Icons.history_rounded, color: DsColor.statePending),
                DsSpace.hGapMd,
                Expanded(
                  child: Text(t('safety.notInRecent'), style: DsText.body(context)),
                ),
              ],
            ),
          ),
        for (final event in rows)
          _SafetyCard(
            event: event,
            childName: event.childId == null ? null : childNames[event.childId],
            highlighted: focused != null && event.id == focused.id,
          ),
      ],
    );
  }
}

class _SafetyCard extends ConsumerWidget {
  const _SafetyCard({
    required this.event,
    required this.childName,
    required this.highlighted,
  });

  final SafetyEvent event;

  /// `null` when the child list did not load, or when the event is
  /// household-level. The card then names no child rather than guessing one.
  final String? childName;

  final bool highlighted;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    final color = _bandColor(event.band);
    final typeKey = 'safetyType.${event.type}';
    // A type this build has no words for gets the neutral label, never the raw
    // string. `hasTranslation` exists for exactly this: a key built from a
    // BACKEND value.
    final typeLabel = locale.has(typeKey) ? t(typeKey) : t('safety.genericType');
    final guidanceKey = 'safetyGuidance.${event.type}';
    final guidance =
        locale.has(guidanceKey) ? t(guidanceKey) : t('safety.genericGuidance');
    final when = _formatWhen(event.occurredAt, t);

    return DsCard(
      accent: highlighted ? color : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(typeLabel, style: DsText.cardTitle(context))),
              DsBadge(label: _bandLabel(event.band, t), color: color),
            ],
          ),
          DsSpace.gapSm,
          // SERVER-AUTHORED, VERBATIM. `COPY_CATALOGUE` on the wellbeing and
          // device paths, `distressParentAlert` on the distress path — never
          // `t()`, and never a sentence this client wrote about what happened.
          if (event.title.isNotEmpty)
            Text(event.title, style: DsText.body(context)),
          if (event.body.isNotEmpty) ...[
            DsSpace.gapXs,
            Text(event.body, style: DsText.body(context)),
          ],
          DsSpace.gapMd,
          Wrap(
            spacing: DsSpace.sm,
            runSpacing: DsSpace.xs,
            children: [
              if (childName != null && childName!.isNotEmpty)
                DsBadge(label: childName!, icon: Icons.person_outline_rounded),
              if (when.isNotEmpty) DsBadge(label: when, icon: Icons.schedule_rounded),
              if (event.isUnread)
                DsBadge(label: t('safety.new'), color: DsColor.accent),
            ],
          ),
          DsSpace.gapMd,
          // WHAT THE PARENT CAN DO. App-authored, calm, and specific to the
          // kind of event rather than to its severity.
          Text(guidance, style: DsText.caption(context)),
          if (event.childId != null) ...[
            DsSpace.gapLg,
            DsSecondaryButton(
              label: childName == null || childName!.isEmpty
                  ? t('safety.openChild')
                  : t('safety.openChildNamed', options: {'name': childName!}),
              // Direction-neutral on purpose: a chevron points the wrong way
              // in one of this app's two locales, and this button is offered
              // in both.
              icon: Icons.person_outline_rounded,
              expand: false,
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => ChildDetailScreen(childId: event.childId!),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  static Color _bandColor(SafetyBand band) {
    switch (band) {
      case SafetyBand.needsAttention:
        return DsColor.stateError;
      case SafetyBand.worthReviewing:
        return DsColor.statePending;
      case SafetyBand.forInformation:
        return DsColor.accent;
    }
  }

  static String _bandLabel(SafetyBand band, String Function(String) t) {
    switch (band) {
      case SafetyBand.needsAttention:
        return t('safetyBand.needsAttention');
      case SafetyBand.worthReviewing:
        return t('safetyBand.worthReviewing');
      case SafetyBand.forInformation:
        return t('safetyBand.forInformation');
    }
  }

  /// «اليوم ١٩:٤٠» / «أمس ١٩:٤٠» / «٢٠٢٦-٠٨-١٧ ١٩:٤٠».
  ///
  /// Computed against `DateTime.now()` at build time and NOT kept live by a
  /// ticker: a safety card that silently rewrote its own timestamp while a
  /// parent read it would need a timer, and a timer would need cancelling.
  /// Returns `''` when the row carried no readable time, and the caller then
  /// omits the badge rather than printing a guess.
  static String _formatWhen(DateTime? occurredAt, String Function(String, {int? count, Map<String, Object>? options}) t) {
    if (occurredAt == null) return '';
    final local = occurredAt.toLocal();
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(local.year, local.month, local.day);
    final daysAgo = today.difference(day).inDays;
    final time = '${_two(local.hour)}:${_two(local.minute)}';

    if (daysAgo == 0) return t('safety.whenToday', options: {'time': time});
    if (daysAgo == 1) return t('safety.whenYesterday', options: {'time': time});
    final date = '${local.year}-${_two(local.month)}-${_two(local.day)}';
    return t('safety.whenOn', options: {'date': date, 'time': time});
  }

  static String _two(int value) => value.toString().padLeft(2, '0');
}
