/// THE CHILD'S HALF OF `abny://` — string in, typed destination out, and it
/// never throws.
///
/// WHAT WAS BROKEN. Every notification this product sends ends in a tap, and
/// on the child's side that tap led nowhere: the message cards in
/// `MyGrowthScreen` acknowledged a message and stopped there. The server half
/// of the gap is closed —
/// `apps/backend/src/modules/notifications/domain/engine/notification-destination.ts`
/// resolves a destination for EVERY notification and delivers it on the row's
/// `data` payload under the key `deepLink`. This file is the client's side of
/// that same contract, and nothing else in this app is allowed to decide where
/// a notification leads.
///
/// THE SERVER IS AUTHORITATIVE. This file parses; it does not infer. It never
/// looks at a notification `type`, never reads the Arabic body, and never
/// guesses a screen from a notification's shape — a client that guessed would
/// be a second opinion nobody can audit, and it would drift from the server
/// inside a sprint.
///
/// ---------------------------------------------------------------------------
/// THE SCHEME, canonical and fixed: `abny://<surface>[/<id>]`. No query string,
/// no fragment, no host, no port, no absolute URL, and never a token. It is
/// matched here with the same shape as the server's own `isValidDeepLink`
/// regex, deliberately: a validator that is *looser* than the producer accepts
/// links the producer would call invalid, and one that is *stricter* rejects
/// links the producer calls valid. Neither is a contract.
///
/// ---------------------------------------------------------------------------
/// TOTALITY. [parseDeepLink] has no failure mode that is not a value: `null`,
/// an empty or blank string, a wrong scheme (`https://`, `abny:/goals`,
/// `ABNY://goals`), an unknown surface, an id whose shape is not an id, an
/// EXTRA segment on a surface that takes none — every one of them returns
/// [DeepLinkDestination.inbox]. There is no path out of here that throws and no
/// path that returns null, because this runs on a path a child reached by
/// tapping something.
///
/// AN ABSENT ID DEGRADES TO THE LIST; A BROKEN ONE DEGRADES TO THE FALLBACK.
/// That split is the one place this file differs from the parent app's copy,
/// and the difference is deliberate. The server already
/// degrades `goal`→`goals`, `approval`→`approvals` and `safety`→`screen-time`
/// at the point where it knows whether an id exists, and it emits the id-less
/// form on every producer path today. Should a bare `abny://goal` ever arrive
/// anyway, the child app applies the SERVER'S OWN degradation table rather than
/// inventing an answer: «the list this thing is in» is a truthful landing for a
/// child, and the child app has no inbox screen of its own to fall back to that
/// would be any more honest. The resulting invariant is worth stating: a
/// destination returned by [parseDeepLink] has a non-null [DeepLinkDestination.id]
/// EXACTLY when its surface takes one.
///
/// IDS ARE OPAQUE, AND SHAPE IS ALL THAT IS CHECKED. The server validates every
/// id as a UUID before interpolating it; this file deliberately does NOT
/// re-impose that, because an id format is the server's to change and a client
/// that hardcodes it turns a server-side widening into a client-side outage.
/// What IS checked is that the segment cannot be anything but an identifier —
/// no path separators, no `?`/`#`, no whitespace, no `.`/`..`, bounded length.
/// AND IT IS NEVER AN AUTHORIZATION CLAIM: an id here says only which row the
/// next screen will ASK for. The server decides whether this device may have
/// it, on that next call, exactly as it does for a row reached by tapping a
/// list.
library;

/// THE CANONICAL SURFACES — one for one with `DEEP_LINK_SURFACES` in
/// `notification-destination.ts`. The wire names live in
/// [deepLinkSurfaceWireName] rather than in the enum, so this stays a plain
/// enum of the kind the rest of this codebase uses.
enum DeepLinkSurface {
  /// the goal / program list
  goals,

  /// one goal, id = `RewardProgram.id`
  goal,

  /// the parent's pending-approval queue — not a child concept
  approvals,

  /// one item awaiting a parent — not a child concept
  approval,

  /// the rewards surface
  rewards,

  /// progress / streaks
  progress,

  /// the AI coach
  coach,

  /// screen-time / wellbeing — wire name `screen-time`
  screenTime,

  /// one safety event, id = alert id
  safety,

  /// one child's detail — parent app only
  child,

  /// subscription & billing — parent app only
  subscription,

  /// the inbox, and the universal fallback
  notifications,
}

/// The wire spelling of [surface]. Exhaustive over the enum on purpose: a
/// surface added without a wire name is a compile error rather than a silent
/// `null` that would parse as "unknown" forever.
String deepLinkSurfaceWireName(DeepLinkSurface surface) => switch (surface) {
      DeepLinkSurface.goals => 'goals',
      DeepLinkSurface.goal => 'goal',
      DeepLinkSurface.approvals => 'approvals',
      DeepLinkSurface.approval => 'approval',
      DeepLinkSurface.rewards => 'rewards',
      DeepLinkSurface.progress => 'progress',
      DeepLinkSurface.coach => 'coach',
      DeepLinkSurface.screenTime => 'screen-time',
      DeepLinkSurface.safety => 'safety',
      DeepLinkSurface.child => 'child',
      DeepLinkSurface.subscription => 'subscription',
      DeepLinkSurface.notifications => 'notifications',
    };

/// The four surfaces whose URI carries an id. Everything else is a list or a
/// tab, and a segment after it is malformed rather than ignorable.
bool deepLinkSurfaceTakesId(DeepLinkSurface surface) => switch (surface) {
      DeepLinkSurface.goal => true,
      DeepLinkSurface.approval => true,
      DeepLinkSurface.safety => true,
      DeepLinkSurface.child => true,
      DeepLinkSurface.goals => false,
      DeepLinkSurface.approvals => false,
      DeepLinkSurface.rewards => false,
      DeepLinkSurface.progress => false,
      DeepLinkSurface.coach => false,
      DeepLinkSurface.screenTime => false,
      DeepLinkSurface.subscription => false,
      DeepLinkSurface.notifications => false,
    };

/// THE SERVER'S OWN DEGRADATION TABLE, COPIED RATHER THAN INVENTED: `goal`
/// without an id is `goals` in `notification-destination.ts`, `approval` is
/// `approvals`, `safety` is `screen-time`. `child` has no list form anywhere in
/// this product — the child app is single-child by construction — so it lands
/// on the universal fallback like anything else without an answer.
///
/// AND A COPY IS WHAT IT IS. These three pairs are the third argument of
/// `idLink(...)` in that file, transcribed. A transcription does not announce
/// that the original moved: if the server widens the table, or changes where
/// one of these degrades to, this app keeps applying yesterday's rule and a
/// child lands somewhere the server did not send them, with nothing red
/// anywhere. `test/core/routing/deep_link_degradation_drift_test.dart` reads
/// `notification-destination.ts` off disk and fails when the two stop
/// agreeing; it is a DETECTOR, not a fix.
///
/// THE FIX IS THE SERVER'S, AND IT SHOULD SHIP THE DEGRADED SURFACE. `idLink`
/// already computes the degraded link server-side — it returns
/// `surfaceLink('goals')` itself when the id is missing — so no client needs to
/// re-derive it. Either keep emitting the already-degraded `abny://goals` (which
/// is what every producer path does today, making this table dead weight in the
/// common case) or publish the pairs alongside `DEEP_LINK_SCHEME` so a client
/// reads them instead of transcribing them. Until then, this switch is a second
/// implementation of somebody else's rule and is treated as one.
///
/// WHAT IS NOT A DEFECT: the two apps route the same link to different places
/// on purpose — this one has no approval queue, no subscription screen and no
/// per-child routing. That split is deliberate, documented, and asserted in
/// `deep_link_test.dart`. Only the DEGRADATION is meant to match.
DeepLinkSurface _idLessFormOf(DeepLinkSurface surface) => switch (surface) {
      DeepLinkSurface.goal => DeepLinkSurface.goals,
      DeepLinkSurface.approval => DeepLinkSurface.approvals,
      DeepLinkSurface.safety => DeepLinkSurface.screenTime,
      DeepLinkSurface.child => DeepLinkSurface.notifications,
      _ => DeepLinkSurface.notifications,
    };

/// A PARSED DESTINATION. Immutable, comparable, and carrying only what the
/// scheme carries: which surface, and — for the four id-bearing surfaces — one
/// opaque id.
class DeepLinkDestination {
  const DeepLinkDestination(this.surface, {this.id});

  final DeepLinkSurface surface;

  /// Non-null exactly when [surface] takes an id — see the library header's
  /// invariant.
  final String? id;

  /// THE UNIVERSAL FALLBACK, and the only value [parseDeepLink] ever invents.
  static const DeepLinkDestination inbox =
      DeepLinkDestination(DeepLinkSurface.notifications);

  bool get isInbox => surface == DeepLinkSurface.notifications;

  /// Round-trips to the canonical form, so a test can assert the parser against
  /// the string the server would have written rather than against itself.
  String get uri {
    final wire = deepLinkSurfaceWireName(surface);
    return id == null ? 'abny://$wire' : 'abny://$wire/$id';
  }

  /// Value equality WITHOUT `operator ==`. Two reasons, and neither is style:
  /// this repository's static gate (`scripts/dart_preflight.py`) does not parse
  /// an operator declaration and reports the `@override` on one as an error, so
  /// an `==` here would make the gate unusable for everyone; and equality on a
  /// two-field value is wanted in exactly one place — a test asserting what a
  /// string parsed to. A named method costs one word at the call site and keeps
  /// this type out of hash sets, where nothing puts it.
  bool matches(DeepLinkDestination other) =>
      other.surface == surface && other.id == id;

  @override
  String toString() => 'DeepLinkDestination($uri)';
}

/// The key the link travels under, on the notification row's `data` object.
/// One spelling, shared with the server's `NOTIFICATION_DEEP_LINK_DATA_KEY` —
/// a payload contract with two spellings is a payload contract with none.
const String deepLinkDataKey = 'deepLink';

/// `abny://<surface>[/<id>]` and nothing else. `[a-z-]` for the surface is what
/// makes `ABNY://GOALS` and `abny://Goals` fail: `Uri.parse` would have
/// lower-cased the host and quietly accepted both, which is precisely the kind
/// of normalisation that lets a client accept links its server rejects.
final RegExp _canonicalLink = RegExp(r'^abny://([a-z-]+)(?:/([^/?#]+))?$');

/// SHAPE ONLY — see the header. Bounded, no separators, no whitespace.
final RegExp _opaqueId = RegExp(r'^[A-Za-z0-9._~-]{1,128}$');

DeepLinkSurface? _surfaceFromWireName(String wire) => switch (wire) {
      'goals' => DeepLinkSurface.goals,
      'goal' => DeepLinkSurface.goal,
      'approvals' => DeepLinkSurface.approvals,
      'approval' => DeepLinkSurface.approval,
      'rewards' => DeepLinkSurface.rewards,
      'progress' => DeepLinkSurface.progress,
      'coach' => DeepLinkSurface.coach,
      'screen-time' => DeepLinkSurface.screenTime,
      'safety' => DeepLinkSurface.safety,
      'child' => DeepLinkSurface.child,
      'subscription' => DeepLinkSurface.subscription,
      'notifications' => DeepLinkSurface.notifications,
      _ => null,
    };

/// THE ONE ENTRY POINT, AND IT IS TOTAL. Every rejection is a value; see the
/// library header.
DeepLinkDestination parseDeepLink(String? link) {
  if (link == null) return DeepLinkDestination.inbox;
  final trimmed = link.trim();
  if (trimmed.isEmpty) return DeepLinkDestination.inbox;

  final match = _canonicalLink.firstMatch(trimmed);
  if (match == null) return DeepLinkDestination.inbox;

  final surface = _surfaceFromWireName(match.group(1) ?? '');
  if (surface == null) return DeepLinkDestination.inbox;

  final id = match.group(2);

  if (!deepLinkSurfaceTakesId(surface)) {
    // A trailing segment on a list surface (`abny://goals/extra`) is not the
    // list with something harmless appended — it is a link this client does not
    // understand, and pretending otherwise would route a child somewhere the
    // server did not send them.
    return id == null ? DeepLinkDestination(surface) : DeepLinkDestination.inbox;
  }

  // AN ABSENT ID AND A BROKEN ID ARE NOT THE SAME EVENT, and they do not
  // degrade to the same place.
  //
  // ABSENT is the server's own id-less form — `notification-destination.ts`
  // emits it deliberately on every producer path today — so it degrades along
  // the server's own table, to the list this thing is in.
  if (id == null) return DeepLinkDestination(_idLessFormOf(surface));

  // BROKEN is a segment the server would never have written: it means this
  // client and that server disagree about the contract, and the honest landing
  // for a broken contract is the fallback rather than a screen picked on the
  // server's behalf. (`.`/`..` are named first because they pass the shape
  // check, and a relative path segment is never an identifier.)
  if (id == '.' || id == '..') return DeepLinkDestination.inbox;
  if (!_opaqueId.hasMatch(id)) return DeepLinkDestination.inbox;
  return DeepLinkDestination(surface, id: id);
}

/// Pulls the link off ONE row as this app receives it: a message from
/// `GET /life-intelligence/self/messages` (`{ id, title, body, data: {...} }`)
/// and, equally, a raw FCM `data` map where the key sits at the top level.
/// Both shapes carry the same key; accepting both means one tap handler serves
/// an in-app card and a cold-start push payload without a second parser.
///
/// Returns `null` when there is no link at all, which [parseDeepLink] already
/// treats as the inbox — so a caller never has to branch on absence.
String? deepLinkFromNotification(Object? notification) {
  if (notification is! Map) return null;

  final direct = notification[deepLinkDataKey];
  if (direct is String) return direct;

  final data = notification['data'];
  if (data is Map) {
    final nested = data[deepLinkDataKey];
    if (nested is String) return nested;
  }
  return null;
}
