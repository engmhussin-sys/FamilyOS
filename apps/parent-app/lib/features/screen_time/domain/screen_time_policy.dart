/// THE TWO NUMBERS A PARENT HAS TO BE ABLE TO TELL APART.
///
/// `GET /children/:childId/screen-time-policy` returns what the parent
/// CONFIGURED. `GET /children/:childId/screen-time-policy/effective` returns
/// what a device actually ENFORCES today — the configured limit PLUS the bonus
/// minutes the child has earned and not yet used up. They are different
/// numbers most days, and a screen that shows only one of them is either
/// hiding the parent's own setting or hiding the child's earned reward.
///
/// The server owns the arithmetic (`ScreenTimeService.getEffectivePolicy`):
/// `effective = base + Σ(active bonus grants)`, and `base == null` — no daily
/// limit set at all — stays `null` rather than becoming a cap the parent never
/// chose. Nothing in this file recomputes any of that; it parses it.
library;

/// THE DTO'S BOUNDS, MIRRORED — AND WHY THEY ARE MIRRORED RATHER THAN GUESSED.
///
/// Transcribed field by field from
/// `apps/backend/src/modules/screen-time/presentation/dto/set-screen-time-policy.dto.ts`:
///
/// ```ts
/// @IsInt() @Min(0) @Max(1440) dailyLimitMinutes?: number;
/// @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/) bedtimeStart?: string;   // "HH:mm", 24h
/// @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/) bedtimeEnd?: string;
/// @IsObject() weekdaySchedule?: Record<string, unknown>;
/// @IsBoolean() focusModeEnabled?: boolean;
/// ```
///
/// The SERVER still decides — `ValidationPipe` refuses anything outside these
/// and the B3 envelope explains why in Arabic. Mirroring them here only means a
/// parent who types `2000` reads a sentence in their own language instead of
/// waiting for a round trip to be told 400.
class ScreenTimePolicyLimits {
  ScreenTimePolicyLimits._();

  /// `@Min(0)`. Zero is LEGAL and meaningful: no screen time at all today.
  static const int minDailyLimitMinutes = 0;

  /// `@Max(1440)` — one full day in minutes.
  static const int maxDailyLimitMinutes = 1440;

  /// The DTO's `TIME_PATTERN`, character for character. 24-hour, zero-padded.
  static final RegExp timePattern = RegExp(r'^([01]\d|2[0-3]):([0-5]\d)$');

  static bool isValidDailyLimit(int? minutes) =>
      minutes == null ||
      (minutes >= minDailyLimitMinutes && minutes <= maxDailyLimitMinutes);

  /// An EMPTY string is valid here and means «not set» — the form clears a
  /// bedtime by emptying the field, and the repository omits an empty value
  /// from the body rather than sending `""`, which `@Matches` would refuse.
  static bool isValidTime(String? value) {
    if (value == null || value.trim().isEmpty) return true;
    return timePattern.hasMatch(value.trim());
  }
}

/// The configured policy row, as `GET /children/:childId/screen-time-policy`
/// returns it. Every field is nullable because the row itself may not exist —
/// a family that has never set a policy gets `null` from that route, which is
/// [ScreenTimePolicy]'s absence rather than a policy full of zeroes.
class ScreenTimePolicy {
  const ScreenTimePolicy({
    required this.id,
    this.dailyLimitMinutes,
    this.bedtimeStart,
    this.bedtimeEnd,
    this.focusModeEnabled = false,
    this.effectiveFrom,
    this.hasWeekdaySchedule = false,
  });

  final String id;

  /// `null` = the parent set NO daily limit. Deliberately not folded into `0`,
  /// which is the opposite instruction («none at all today»).
  final int? dailyLimitMinutes;

  /// `"HH:mm"`, local to the CHILD's device — the server's own comment on the
  /// column. Kept as the string it is: converting it to a `DateTime` here
  /// would attach this phone's date and timezone to a value that has neither.
  final String? bedtimeStart;
  final String? bedtimeEnd;

  final bool focusModeEnabled;
  final DateTime? effectiveFrom;

  bool get hasDailyLimit => dailyLimitMinutes != null;

  bool get hasBedtime =>
      (bedtimeStart != null && bedtimeStart!.isNotEmpty) &&
      (bedtimeEnd != null && bedtimeEnd!.isNotEmpty);

  /// `weekdaySchedule` IS DETECTED BUT NOT RENDERED, and that is a decision
  /// rather than an omission. The backend's own type calls its shape «owned by
  /// the frontend for now» and validates it only as «is it an object»;
  /// inventing a per-weekday editor against a shape nobody has agreed would
  /// put a contract on screen that the server does not enforce. This flag lets
  /// the overview say «per-day overrides exist» truthfully without pretending
  /// to know what they say — and lets the editor warn before a save that would
  /// drop them (`setPolicy` REPLACES the row; it does not merge).
  final bool hasWeekdaySchedule;

  static ScreenTimePolicy? fromJson(Object? body) {
    if (body is! Map) return null;
    final id = body['id'];
    // `GET` answers a family with no policy with a null body, which
    // `ApiClient._unwrap` hands over as `{'data': null}`. No id, no policy.
    if (id is! String || id.isEmpty) return null;
    return ScreenTimePolicy(
      id: id,
      dailyLimitMinutes: (body['dailyLimitMinutes'] as num?)?.toInt(),
      bedtimeStart: body['bedtimeStart']?.toString(),
      bedtimeEnd: body['bedtimeEnd']?.toString(),
      focusModeEnabled: body['focusModeEnabled'] == true,
      effectiveFrom: _parseDate(body['effectiveFrom']),
      hasWeekdaySchedule:
          body['weekdaySchedule'] is Map && (body['weekdaySchedule'] as Map).isNotEmpty,
    );
  }
}

/// WHERE ONE GRANT STANDS, as the SERVER sees it.
///
/// Never computed from `DateTime.now()` on the handset. `revoked` reads a
/// timestamp the server wrote; `active` and `ended` come from the set of ids
/// the effective-policy route reports as live right now. [unknown] is a real
/// answer, not a default: it is what a screen has when that read failed, and
/// it renders as no badge at all rather than as a standing nobody can back.
enum GrantStanding { active, ended, revoked, unknown }

/// ONE MODEL FOR ONE DATABASE ROW — `screen_time_reward_grant`.
///
/// There were two. This app read the same row through two routes and built a
/// different class for each: `ScreenTimeBonusGrant` here for the pre-filtered
/// `bonusGrants` of the effective policy, and a `ScreenTimeGrant` in
/// `rewards/domain/fulfilment.dart` for the unfiltered history at
/// `GET /reward-programs/screen-time-grants/:childId`. One of them decided
/// active/expired/revoked locally, the other trusted the list it came in; each
/// had its own date-cut helper, and the second one's comment admitted it was
/// copying the first. Two answers to «is this grant live» in one app is the
/// same defect class as two answers to «how many bonus minutes».
///
/// The two routes differ only in WHAT THEY OMIT, so the class carries both
/// shapes and nothing is invented: `childId` and `revokedAt` are absent from
/// the effective-policy shape (`IScreenTimeBonusGrant` is
/// `{id, minutes, grantedAt, expiresAt}`), and absent means `null`, not a
/// fabricated empty string.
///
/// Note what a grant is NOT: an edit to the child's screen-time policy. The
/// base policy row is untouched and this expires on its own.
class ScreenTimeGrant {
  const ScreenTimeGrant({
    required this.id,
    required this.minutes,
    this.childId,
    this.grantedAt,
    this.expiresAt,
    this.revokedAt,
    this.achievementId,
  });

  final String id;
  final int minutes;

  /// Absent from the effective-policy shape, which is already scoped to one
  /// child by its own route.
  final String? childId;

  final DateTime? grantedAt;
  final DateTime? expiresAt;

  /// Absent from the effective-policy shape for a different reason: that route
  /// never returns a revoked grant at all.
  final DateTime? revokedAt;

  final String? achievementId;

  /// A STORED SERVER FACT — a timestamp the server wrote — not a comparison
  /// against this handset's clock. That is why it survives while
  /// `isActiveAt(now)` and `isExpiredAt(now)` were deleted: those asked the
  /// device to re-decide something the server had already decided, and the
  /// answer differed from the server's whenever the two clocks did.
  bool get isRevoked => revokedAt != null;

  factory ScreenTimeGrant.fromJson(Map<String, dynamic> json) => ScreenTimeGrant(
        id: json['id']?.toString() ?? '',
        minutes: (json['minutes'] as num?)?.toInt() ?? 0,
        childId: json['childId']?.toString(),
        grantedAt: _parseDate(json['grantedAt']),
        expiresAt: _parseDate(json['expiresAt']),
        revokedAt: _parseDate(json['revokedAt']),
        achievementId: json['achievementId']?.toString(),
      );
}

/// `GET …/screen-time-policy/effective` — `IEffectiveScreenTimePolicy`:
/// `{policy, effectiveDailyLimitMinutes, baseDailyLimitMinutes, bonusMinutes,
/// bonusGrants}`. Field names taken from that interface, not assumed.
class EffectiveScreenTimePolicy {
  const EffectiveScreenTimePolicy({
    this.policy,
    this.baseDailyLimitMinutes,
    this.effectiveDailyLimitMinutes,
    this.bonusMinutes = 0,
    this.bonusGrants = const <ScreenTimeGrant>[],
  });

  /// The same configured row the other route returns, embedded. Present here
  /// so a screen that only needs the effective view still makes one call.
  final ScreenTimePolicy? policy;

  final int? baseDailyLimitMinutes;
  final int? effectiveDailyLimitMinutes;
  final int bonusMinutes;
  /// The grants the SERVER counts right now — already filtered on
  /// `revokedAt: null, expiresAt: { gt: now }` at the server's own clock. Their
  /// ids are what tells any screen which rows of the full history are live.
  final List<ScreenTimeGrant> bonusGrants;

  /// THE ONE CASE WHERE A REWARD BUYS NOTHING, AND THE UI HAS TO SAY SO.
  /// With no base limit the allowance is already unlimited, so bonus minutes
  /// change nothing — the server keeps `effectiveDailyLimitMinutes` null
  /// rather than inventing a cap, and the overview screen explains it instead
  /// of silently showing «—».
  bool get hasNoLimit => effectiveDailyLimitMinutes == null;

  bool get hasBonus => bonusMinutes > 0;

  factory EffectiveScreenTimePolicy.fromJson(Map<String, dynamic> json) {
    final grants = json['bonusGrants'];
    return EffectiveScreenTimePolicy(
      policy: ScreenTimePolicy.fromJson(json['policy']),
      baseDailyLimitMinutes: (json['baseDailyLimitMinutes'] as num?)?.toInt(),
      effectiveDailyLimitMinutes:
          (json['effectiveDailyLimitMinutes'] as num?)?.toInt(),
      bonusMinutes: (json['bonusMinutes'] as num?)?.toInt() ?? 0,
      bonusGrants: grants is List
          ? grants
              .whereType<Map<String, dynamic>>()
              .map(ScreenTimeGrant.fromJson)
              .toList()
          : const <ScreenTimeGrant>[],
    );
  }
}

DateTime? _parseDate(Object? value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString());
}
