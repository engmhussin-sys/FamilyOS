/// THE ACHIEVEMENT REQUEST and its append-only verification attempts.
library;

class AchievementStatuses {
  AchievementStatuses._();

  static const String requested = 'REQUESTED';
  static const String inProgress = 'IN_PROGRESS';
  static const String submitted = 'SUBMITTED';
  static const String pendingParent = 'PENDING_PARENT';
  static const String verified = 'VERIFIED';
  static const String rejected = 'REJECTED';
  static const String expired = 'EXPIRED';

  /// The two statuses `GET /reward-programs/achievements/pending` returns.
  static const Set<String> awaitingParent = {submitted, pendingParent};
}

class AchievementRequest {
  const AchievementRequest({
    required this.id,
    required this.programId,
    required this.childId,
    required this.status,
    required this.attemptNo,
    this.localDate,
    this.startedAt,
    this.submittedAt,
    this.decidedAt,
    this.decidedByUserId,
    this.elapsedMinutes,
    this.appliedMultiplierBps,
    this.streakDaysAtVerification,
    this.grantedAmount,
  });

  final String id;
  final String programId;
  final String childId;
  final String status;
  final int attemptNo;

  /// The FAMILY-LOCAL business date, decided server-side (B1/B2). The
  /// client never computes it and never converts it — it is already a
  /// calendar day, not an instant.
  final String? localDate;

  final DateTime? startedAt;
  final DateTime? submittedAt;
  final DateTime? decidedAt;
  final String? decidedByUserId;

  /// SERVER-MEASURED from its own `startedAt`. The device's own count is
  /// evidence the server bounds, never the number of record.
  final int? elapsedMinutes;

  /// Frozen at verification time — read back, never recomputed.
  final int? appliedMultiplierBps;
  final int? streakDaysAtVerification;
  final int? grantedAmount;

  bool get isAwaitingParent => AchievementStatuses.awaitingParent.contains(status);
  bool get isVerified => status == AchievementStatuses.verified;
  bool get isRejected => status == AchievementStatuses.rejected;

  /// 10000 bps → "1.0". Presentation-only formatting of a server number.
  String get multiplierLabel {
    final bps = appliedMultiplierBps;
    if (bps == null) return '';
    return (bps / 10000).toStringAsFixed(bps % 10000 == 0 ? 1 : 2);
  }

  factory AchievementRequest.fromJson(Map<String, dynamic> json) => AchievementRequest(
        id: json['id']?.toString() ?? '',
        programId: json['programId']?.toString() ?? '',
        childId: json['childId']?.toString() ?? '',
        status: json['status']?.toString() ?? AchievementStatuses.requested,
        attemptNo: (json['attemptNo'] as num?)?.toInt() ?? 1,
        localDate: _dateOnly(json['localDate']),
        startedAt: _parseDate(json['startedAt']),
        submittedAt: _parseDate(json['submittedAt']),
        decidedAt: _parseDate(json['decidedAt']),
        decidedByUserId: json['decidedByUserId']?.toString(),
        elapsedMinutes: (json['elapsedMinutes'] as num?)?.toInt(),
        appliedMultiplierBps: (json['appliedMultiplierBps'] as num?)?.toInt(),
        streakDaysAtVerification: (json['streakDaysAtVerification'] as num?)?.toInt(),
        grantedAmount: (json['grantedAmount'] as num?)?.toInt(),
      );
}

/// One row of the append-only verification log. The parent's review screen
/// shows every one of them in order, including the SYSTEM ones — that
/// history is the audit trail F4 built and no client has ever displayed.
class VerificationAttempt {
  const VerificationAttempt({
    required this.id,
    required this.method,
    required this.result,
    required this.reasonCode,
    required this.attemptNumber,
    required this.verifierType,
    this.scorePercent,
    this.evidenceRef,
    this.createdAt,
  });

  final String id;
  final String method;

  /// PASSED | FAILED | ESCALATED.
  final String result;

  /// e.g. `PARENT_APPROVED`, `ATTEMPTS_EXHAUSTED`, `DURATION_SHORT`.
  final String reasonCode;
  final int attemptNumber;

  /// SYSTEM | PARENT — which principal decided. The whole point of the
  /// column is that the two are distinguishable forever.
  final String verifierType;

  final int? scorePercent;
  final String? evidenceRef;
  final DateTime? createdAt;

  bool get isPassed => result == 'PASSED';
  bool get isEscalated => result == 'ESCALATED';
  bool get byParent => verifierType == 'PARENT';

  factory VerificationAttempt.fromJson(Map<String, dynamic> json) => VerificationAttempt(
        id: json['id']?.toString() ?? '',
        method: json['method']?.toString() ?? '',
        result: json['result']?.toString() ?? '',
        reasonCode: json['reasonCode']?.toString() ?? '',
        attemptNumber: (json['attemptNumber'] as num?)?.toInt() ?? 0,
        verifierType: json['verifierType']?.toString() ?? 'SYSTEM',
        scorePercent: (json['scorePercent'] as num?)?.toInt(),
        evidenceRef: json['evidenceRef']?.toString(),
        createdAt: _parseDate(json['createdAt']),
      );
}

/// B5 — uploaded evidence METADATA. Never the bytes and never a storage
/// key: the file itself comes from a separate authenticated route that
/// streams it through the application so every read of a child's voice
/// recording passes the parent JWT guard and the tenant extension.
class EvidenceRef {
  const EvidenceRef({
    required this.id,
    required this.kind,
    required this.mimeType,
    required this.byteSize,
    this.createdAt,
  });

  final String id;

  /// AUDIO | IMAGE — decided from the file's MAGIC BYTES server-side, not
  /// from the `Content-Type` the device claimed.
  final String kind;

  final String mimeType;
  final int byteSize;
  final DateTime? createdAt;

  /// Presentation-only, for a one-line "2.4 MB" label.
  String get sizeLabel => byteSize < 1024 * 1024
      ? '${(byteSize / 1024).toStringAsFixed(0)} KB'
      : '${(byteSize / (1024 * 1024)).toStringAsFixed(1)} MB';

  factory EvidenceRef.fromJson(Map<String, dynamic> json) => EvidenceRef(
        id: json['id']?.toString() ?? '',
        kind: json['kind']?.toString() ?? '',
        mimeType: json['mimeType']?.toString() ?? '',
        byteSize: (json['byteSize'] as num?)?.toInt() ?? 0,
        createdAt: _parseDate(json['createdAt']),
      );
}

/// B5 — `GET /reward-programs/achievements/:id` returns both halves of a
/// review in one round trip.
class AchievementDetail {
  const AchievementDetail({required this.attempts, required this.evidence});

  final List<VerificationAttempt> attempts;
  final List<EvidenceRef> evidence;

  factory AchievementDetail.fromJson(Map<String, dynamic> json) => AchievementDetail(
        attempts: (json['attempts'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(VerificationAttempt.fromJson)
            .toList(),
        evidence: (json['evidence'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(EvidenceRef.fromJson)
            .toList(),
      );
}

/// An AI suggestion. A DRAFT and nothing else — `GET
/// /reward-programs/suggestions/:childId` creates no row, and the only
/// path from here to a real program is the parent's explicit
/// `POST /reward-programs/suggestions/accept` (CONTEXT §3 principle 2).
class ProgramSuggestion {
  const ProgramSuggestion({
    required this.suggestionId,
    required this.previewAr,
    required this.rationaleAr,
    this.category,
    this.durationMinutes,
  });

  /// Deterministic, derived server-side from (childId, category, activity,
  /// target) — the same inputs always produce the same id, which is what
  /// lets a parent accept a suggestion they saw a minute ago. The accept
  /// call sends only this id; the server RE-DERIVES the draft rather than
  /// trusting a body, so a client cannot smuggle in a program the AI never
  /// proposed.
  final String suggestionId;

  /// «قرآن · الآيات 1–5 من سورة الملك · 20 دقيقة · 20 نقطة» — composed
  /// server-side, rendered verbatim.
  final String previewAr;

  final String rationaleAr;
  final String? category;
  final int? durationMinutes;

  factory ProgramSuggestion.fromJson(Map<String, dynamic> json) {
    final draft = (json['draft'] as Map?)?.cast<String, dynamic>() ?? const {};
    return ProgramSuggestion(
      suggestionId: json['suggestionId']?.toString() ?? '',
      previewAr: json['previewAr']?.toString() ?? '',
      rationaleAr: json['rationaleAr']?.toString() ?? '',
      category: draft['category']?.toString(),
      durationMinutes: (draft['durationMinutes'] as num?)?.toInt(),
    );
  }
}

DateTime? _parseDate(Object? value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString());
}

/// `local_date` is a `@db.Date`, serialised as an ISO instant at UTC
/// midnight. It is a CALENDAR DAY and must never be re-zoned on the
/// client — taking the first 10 characters is the only correct read.
String? _dateOnly(Object? value) {
  if (value == null) return null;
  final text = value.toString();
  return text.length >= 10 ? text.substring(0, 10) : text;
}
