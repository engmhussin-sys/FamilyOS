/// B8 — THE CHILD'S COACH, AS THE CHILD APP SEES IT.
///
/// Four types, mirroring `apps/backend/src/modules/ai-core` exactly:
/// `ChildEncouragement` ← `GET /self/coach/today`
/// `CoachTopic`         ← `GET /self/coach/topics`
/// `CoachAnswer`        ← `GET /self/coach/answer/:topicCode`
/// `CheckinOutcome`     ← `POST /self/coach/checkin`
///
/// EVERY USER-VISIBLE SENTENCE IN THESE TYPES IS SERVER-AUTHORED ARABIC.
/// `messageAr`, `questionAr`, `answerAr`, `titleAr`, `bodyAr` are not i18n
/// keys and must never be routed through `t(...)`: they are human-written,
/// age-banded copy that has already passed `SafetyEngineService.validate`
/// at the child's own band on the server. The app's own chrome — button
/// labels, section headers, the check-in prompt — is localized normally.
/// Mixing the two is how a filtered sentence gets replaced by an
/// unfiltered one.
library;

/// Why the server chose the line it chose. Rendered as a MOOD, never as
/// text: a child is never shown the word `RESTART`, which is a label for
/// the fact that they broke a streak.
enum CoachIntent { celebrate, nudge, restart, rest, unknown }

CoachIntent _intentFrom(Object? raw) {
  switch (raw) {
    case 'CELEBRATE':
      return CoachIntent.celebrate;
    case 'NUDGE':
      return CoachIntent.nudge;
    case 'RESTART':
      return CoachIntent.restart;
    case 'REST':
      return CoachIntent.rest;
    default:
      // A code this client has never heard of is NOT an error and must not
      // be rendered raw. The sentence still arrives in `messageAr`; only
      // the decorative mood falls back.
      return CoachIntent.unknown;
  }
}

String _str(Object? raw) => raw is String ? raw : '';

/// «رسالة اليوم» — the encouragement card.
class ChildEncouragement {
  const ChildEncouragement({
    required this.intent,
    required this.messageAr,
    required this.ageBand,
    required this.businessDate,
  });

  factory ChildEncouragement.fromJson(Map<String, dynamic> json) => ChildEncouragement(
        intent: _intentFrom(json['intent']),
        messageAr: _str(json['messageAr']),
        ageBand: _str(json['ageBand']),
        businessDate: _str(json['businessDate']),
      );

  final CoachIntent intent;

  /// Server-authored, safety-filtered, band-appropriate. Rendered verbatim.
  final String messageAr;

  final String ageBand;

  /// The FAMILY's business date, not the device's. Not displayed — carried
  /// so a stale card can be told apart from a fresh one without trusting
  /// the child's clock.
  final String businessDate;

  bool get isEmpty => messageAr.trim().isEmpty;
}

/// One button in the closed question vocabulary.
///
/// `code` is an enum member on the server (`CHILD_TOPIC_CODES`, nine values)
/// and is never shown to the child — it exists only to be sent back. What
/// the child reads is `questionAr`.
class CoachTopic {
  const CoachTopic({required this.code, required this.questionAr});

  factory CoachTopic.fromJson(Map<String, dynamic> json) => CoachTopic(
        code: _str(json['code']),
        questionAr: _str(json['questionAr']),
      );

  final String code;
  final String questionAr;

  bool get isRenderable => code.isNotEmpty && questionAr.trim().isNotEmpty;
}

/// The answer to one topic code, at the child's own age band.
class CoachAnswer {
  const CoachAnswer({required this.code, required this.answerAr, required this.ageBand});

  factory CoachAnswer.fromJson(Map<String, dynamic> json) => CoachAnswer(
        code: _str(json['code']),
        answerAr: _str(json['answerAr']),
        ageBand: _str(json['ageBand']),
      );

  final String code;
  final String answerAr;
  final String ageBand;
}

/// One helpline row on the safety card.
class CoachHelpline {
  const CoachHelpline({required this.country, required this.labelAr, required this.number});

  factory CoachHelpline.fromJson(Map<String, dynamic> json) => CoachHelpline(
        country: _str(json['country']),
        labelAr: _str(json['labelAr']),
        number: _str(json['number']),
      );

  final String country;
  final String labelAr;
  final String number;
}

/// THE SAFETY CARD — one fixed, human-written response, identical for every
/// distress code by design so the card never tells a child how serious the
/// classifier judged their words to be.
class DistressCard {
  const DistressCard({required this.titleAr, required this.bodyAr, required this.helplines});

  factory DistressCard.fromJson(Map<String, dynamic> json) => DistressCard(
        titleAr: _str(json['titleAr']),
        bodyAr: _str(json['bodyAr']),
        helplines: (json['helplines'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(CoachHelpline.fromJson)
            .toList(growable: false),
      );

  final String titleAr;
  final String bodyAr;
  final List<CoachHelpline> helplines;
}

/// THE RESULT OF «كيف تشعر اليوم؟».
///
/// THE ASYMMETRY HERE IS DELIBERATE AND MUST SURVIVE REFACTORING. On no
/// signal the server returns today's ORDINARY encouragement — byte-for-byte
/// the card `GET /self/coach/today` would have returned. The UI therefore
/// renders the non-escalated branch through the SAME widget as the normal
/// card and adds nothing: no "thanks", no checkmark, no "all good".
///
/// If this client ever rendered the two branches differently, a child could
/// learn what the classifier reacts to by watching the screen change — which
/// is precisely what the server's design avoids by returning the same shape.
class CheckinOutcome {
  const CheckinOutcome({required this.escalated, this.card, this.encouragement});

  factory CheckinOutcome.fromJson(Map<String, dynamic> json) {
    final escalated = json['escalated'] == true;
    final card = json['card'];
    final encouragement = json['encouragement'];
    return CheckinOutcome(
      escalated: escalated,
      card: card is Map<String, dynamic> ? DistressCard.fromJson(card) : null,
      encouragement: encouragement is Map<String, dynamic>
          ? ChildEncouragement.fromJson(encouragement)
          : null,
    );
  }

  final bool escalated;
  final DistressCard? card;
  final ChildEncouragement? encouragement;
}
