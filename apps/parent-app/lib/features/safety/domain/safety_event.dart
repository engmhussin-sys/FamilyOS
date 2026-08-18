/// ONE SAFETY EVENT, AS A PARENT MAY SEE IT — and nothing else off the row.
///
/// WHERE THE ROWS COME FROM. `GET /notifications`
/// (`notifications.controller.ts:14`), the SAME route the inbox already reads.
/// It is not a second opinion about what a safety event is: the server's own
/// `NOTIFICATION_CLASSES` table (`src/shared/notifications/notification-class.ts`)
/// classifies every notification type, and [SafetyEventTypes] is the
/// `category: 'SAFETY'` + `audience: 'PARENT'` rows of that table, transcribed.
/// The client filters for DISPLAY; it does not decide what is safety-relevant.
///
/// WHY NOT `GET /pairing/alerts`. That route exists and is parent-guarded
/// (`pairing.controller.ts:204`), but `PrismaRuntimeAlertRepository.listForUser`
/// reads `notification` rows `WHERE userId = … AND type = 'RUNTIME_ALERT'` — so
/// it is a STRICT SUBSET of the inbox route, and the subset it keeps is the one
/// type that is NOT the interesting one. Since Phase E, `DigitalWellbeingEngineService`
/// sends the real type (`PROTECTION_BYPASS_ATTEMPT`, `POLICY_VIOLATION`, …)
/// instead of the generic `RUNTIME_ALERT`, and `distress-escalation.service.ts`
/// writes `CHILD_WELLBEING_CHECKIN`. A screen built on `/pairing/alerts` would
/// therefore show the two legacy device alerts and MISS the distress
/// check-in — the single most important notification this product sends.
/// `RUNTIME_ALERT` is in the list below, so this screen is a superset of that
/// route rather than a competitor to it, and it costs one HTTP call, not two.
///
/// ---------------------------------------------------------------------------
/// WHAT IS DELIBERATELY NOT READ: `data`.
///
/// `notifications.data` carries the PRODUCER'S payload verbatim, and one of the
/// producers (`DigitalWellbeingEngineService`) spreads a DEVICE-SUPPLIED
/// `metadata` object into it — an open-ended map whose contents nobody at that
/// layer has enumerated. `notification-destination.ts` says so in its own
/// header. Rendering any of it would mean putting text a device chose on a
/// parent's safety screen, and on the distress path it would risk undoing the
/// one guarantee that path is built around: `distress-escalation.service.ts`
/// records «CODE AND TIME ONLY … not `freeText`, any substring of it, any
/// length of it, and any hash of it», and sends a GENERIC parent alert on
/// purpose. So this type has no `data` field, no `metadata` field, and no way
/// to grow one by accident — [fromJson] never touches the key.
///
/// `title` and `body` ARE rendered, verbatim and never through `t()`: those are
/// server-authored (`COPY_CATALOGUE` / `distressParentAlert`), which is the
/// only text on this screen that is allowed to describe what happened.
library;

/// THE SAFETY-CLASS TYPES, transcribed from `notification-class.ts`.
///
/// A type absent from this list is not shown here — which is a display choice
/// and never a claim that nothing happened; every notification, safety or not,
/// remains in the inbox where it has always been.
///
/// `CHILD_REQUEST` is `category: 'SAFETY'` in that table and is deliberately
/// NOT here: the server routes it to the approval queue (`approvalDestination`),
/// because a child asking for more time is a DECISION waiting on a parent, not
/// a protection event. Listing it in two places would make the safety screen a
/// second, competing queue.
class SafetyEventTypes {
  const SafetyEventTypes._();

  /// The enforcement surface itself is off. Bypasses quiet hours server-side.
  static const String accessibilityDisabled = 'ACCESSIBILITY_DISABLED';

  /// An active attempt to defeat protection. Bypasses quiet hours server-side.
  static const String protectionBypassAttempt = 'PROTECTION_BYPASS_ATTEMPT';

  /// The distress-escalation alert. Bypasses quiet hours server-side.
  static const String wellbeingCheckin = 'CHILD_WELLBEING_CHECKIN';

  /// A report, not an emergency — the server defers it past quiet hours.
  static const String policyViolation = 'POLICY_VIOLATION';

  /// The limit was already enforced on the device before this was sent.
  static const String screenTimeExceeded = 'SCREEN_TIME_EXCEEDED';

  /// The generic device alert — everything `GET /pairing/alerts` returns.
  static const String runtimeAlert = 'RUNTIME_ALERT';

  static const List<String> all = <String>[
    accessibilityDisabled,
    protectionBypassAttempt,
    wellbeingCheckin,
    policyViolation,
    screenTimeExceeded,
    runtimeAlert,
  ];

  static bool isSafety(String type) => all.contains(type);
}

/// HOW MUCH OF A PARENT'S ATTENTION THIS ASKS FOR, and it is three words rather
/// than a number.
///
/// It mirrors the server's own quiet-hours class, which is the only place in
/// this product where «is this worth waking a household» has been answered with
/// a written justification per type: `DELIVER` becomes [needsAttention],
/// `DEFER` becomes [worthReviewing]. It is NOT derived from
/// `notifications.priority`, whose vocabulary (`CRITICAL`, `HIGH`, …) is a
/// database value a parent must never read, and whose meaning is loudness
/// rather than urgency.
enum SafetyBand {
  /// Protection is off, being defeated, or a child has signalled distress.
  needsAttention,

  /// Real, recorded, and it keeps until the parent has a quiet moment.
  worthReviewing,

  /// Context. Nothing is asked of the parent.
  forInformation,
}

SafetyBand safetyBandOf(String type) {
  switch (type) {
    case SafetyEventTypes.accessibilityDisabled:
    case SafetyEventTypes.protectionBypassAttempt:
    case SafetyEventTypes.wellbeingCheckin:
      return SafetyBand.needsAttention;
    case SafetyEventTypes.policyViolation:
    case SafetyEventTypes.screenTimeExceeded:
      return SafetyBand.worthReviewing;
    default:
      return SafetyBand.forInformation;
  }
}

class SafetyEvent {
  const SafetyEvent({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.isUnread,
    this.childId,
    this.occurredAt,
  });

  /// The `notifications.id` — and the id an `abny://safety/<id>` link would
  /// name if a producer ever carried one (see the screen's own header).
  final String id;

  /// The server's own type string. NEVER RENDERED. It selects a localised
  /// label and a band, and that is the whole of its presence on screen.
  final String type;

  /// Server-authored, rendered VERBATIM. May be empty on a malformed row, in
  /// which case the screen falls back to the localised type label.
  final String title;

  /// Server-authored, rendered VERBATIM. May be empty.
  final String body;

  final bool isUnread;

  /// `null` for a household-level row, or for a row this build could not read
  /// an id off. The screen shows no child name and offers no child link then —
  /// it does not guess.
  final String? childId;

  /// `notifications.createdAt`. `null` when unparseable; the screen then omits
  /// the "when" line rather than printing a wrong one.
  final DateTime? occurredAt;

  SafetyBand get band => safetyBandOf(type);

  /// `null` for a row that is not a parent safety event, or that this build
  /// cannot read. The caller drops those — same discipline as
  /// `ChildConsent.fromJson`: a malformed row is dropped and the rest of the
  /// screen still renders, which on a safety surface beats showing nothing.
  ///
  /// It reads exactly six keys and `data` is not one of them. See the library
  /// header for why that is a rule and not an omission.
  static SafetyEvent? fromJson(Object? row) {
    if (row is! Map) return null;

    final id = row['id'];
    if (id is! String || id.isEmpty) return null;

    final type = row['type'];
    if (type is! String || !SafetyEventTypes.isSafety(type)) return null;

    final title = row['title'];
    final body = row['body'];
    final childId = row['childId'];
    final createdAt = row['createdAt'];

    return SafetyEvent(
      id: id,
      type: type,
      title: title is String ? title : '',
      body: body is String ? body : '',
      isUnread: row['readAt'] == null,
      childId: childId is String && childId.isNotEmpty ? childId : null,
      occurredAt: createdAt is String ? DateTime.tryParse(createdAt) : null,
    );
  }
}
