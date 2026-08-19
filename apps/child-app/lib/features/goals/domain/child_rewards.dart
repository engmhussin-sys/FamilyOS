/// «جوايزي» و«تتابعي» — what the child has earned and how long they have
/// kept it up.
library;

/// `GET /self/achievements/streaks` returns `{quran, reading, exercise,
/// learning, behaviour}` — five buckets, RECOMPUTED server-side from
/// verified rows on every call. There is deliberately no streak table and
/// therefore no client-side streak arithmetic either.
class StreakSet {
  const StreakSet(this.byKind);

  final Map<String, int> byKind;

  /// The order the child sees. Fixed, not sorted by value — a leaderboard
  /// of your own habits is a comparison you did not ask for.
  static const List<String> kinds = ['quran', 'reading', 'exercise', 'learning', 'behaviour'];

  int of(String kind) => byKind[kind] ?? 0;

  int get best => byKind.values.fold<int>(0, (a, b) => a > b ? a : b);

  bool get isEmpty => byKind.isEmpty || best == 0;

  factory StreakSet.fromJson(Map<String, dynamic> json) => StreakSet({
        for (final entry in json.entries)
          entry.key: (entry.value as num?)?.toInt() ?? 0,
      });
}

/// One batch of earned screen-time minutes, exactly as the server reported it.
///
/// NOTE WHAT IS NOT HERE ANY MORE: `isActiveAt(now)`. It answered «is this
/// grant still running?» by comparing [expiresAt] against this handset's
/// `DateTime.now()` — a second implementation of a rule the server had already
/// applied, evaluated on a clock nobody controls. `my_rewards_screen.dart`
/// dimmed and badged every row with that local answer while rendering the
/// server's `activeBonusMinutes` immediately above them, so a phone running
/// fast, or an expiry passing while the screen sat open, made the total and the
/// rows contradict each other in front of the child — about minutes the child
/// earned.
///
/// AND IT CANNOT BE RESTORED HONESTLY ON THIS ROUTE. `GET
/// /self/achievements/rewards` (`ChildAchievementsController.rewards`) returns
/// `screenTimeGrants` filtered on `revokedAt: null` and nothing else — the full
/// unrevoked history, with no per-grant live flag and no set of the ids the
/// server currently counts. The route that carries that set, `GET
/// /children/:childId/screen-time-policy/effective`, is `@ParentSurface()`
/// behind `JwtAuthGuard`; a paired child device's token cannot reach it, and
/// this app cannot change the backend. So «is THIS row live right now?» is a
/// question the child app has no server answer to, and it has stopped
/// inventing one. The live figure it does have — the server's
/// [ChildRewardsSnapshot.activeBonusMinutes] — is the one the screen shows.
///
/// [expiresAt] and [revokedAt] stay because they are facts the server sent and
/// the model should not drop them. They decide nothing here: no member of this
/// class compares either of them against a clock.
class ChildScreenTimeGrant {
  const ChildScreenTimeGrant({
    required this.id,
    required this.minutes,
    this.expiresAt,
    this.revokedAt,
  });

  final String id;
  final int minutes;
  final DateTime? expiresAt;
  final DateTime? revokedAt;

  factory ChildScreenTimeGrant.fromJson(Map<String, dynamic> json) => ChildScreenTimeGrant(
        id: json['id']?.toString() ?? '',
        minutes: (json['minutes'] as num?)?.toInt() ?? 0,
        expiresAt: DateTime.tryParse(json['expiresAt']?.toString() ?? ''),
        revokedAt: DateTime.tryParse(json['revokedAt']?.toString() ?? ''),
      );
}

class ChildFulfilment {
  const ChildFulfilment({
    required this.id,
    required this.rewardType,
    required this.description,
    required this.status,
    required this.quantity,
  });

  final String id;
  final String rewardType;
  final String description;
  final String status;
  final int quantity;

  bool get isWaitingOnParent => status == 'PENDING' || status == 'APPROVED';
  bool get isDelivered => status == 'FULFILLED';

  factory ChildFulfilment.fromJson(Map<String, dynamic> json) => ChildFulfilment(
        id: json['id']?.toString() ?? '',
        rewardType: json['rewardType']?.toString() ?? '',
        description: json['description']?.toString() ?? '',
        status: json['status']?.toString() ?? 'PENDING',
        quantity: (json['quantity'] as num?)?.toInt() ?? 1,
      );
}

/// `GET /self/achievements/rewards` — `{activeBonusMinutes, screenTimeGrants,
/// fulfilments}`.
///
/// [grants] is the HISTORY — every unrevoked grant this child was ever given,
/// live or long finished. [activeBonusMinutes] is the LIVE figure, and it is
/// not a summary of that list: the server computes it in
/// `PrismaRewardProgramRepository.activeBonusMinutes` over
/// `revokedAt: null, expiresAt > now` at the SERVER's `now`, which is the same
/// number `ScreenTimeService.getEffectivePolicy` adds to the base policy and
/// the same number the parent's screens render. The client displays it and
/// never re-adds the list.
class ChildRewardsSnapshot {
  const ChildRewardsSnapshot({
    required this.activeBonusMinutes,
    required this.grants,
    required this.fulfilments,
  });

  /// `null` means THE SERVER DID NOT SAY — the field was absent or unreadable
  /// in the response. It is not zero, and the screen does not print it as
  /// zero: it prints `myRewards.bonusUnknown`, «مقدرناش نعرف دقايقك الزيادة
  /// دلوقتي», which is a different sentence from «صفر دقيقة». Telling a child
  /// their earned minutes vanished because a field did not arrive is the
  /// worse of the two mistakes.
  final int? activeBonusMinutes;

  final List<ChildScreenTimeGrant> grants;
  final List<ChildFulfilment> fulfilments;

  /// A read that returned an explicit zero and nothing else is genuinely
  /// empty. An UNKNOWN total is not: `null` falls through to the data view,
  /// which states that it could not be read.
  bool get isEmpty => activeBonusMinutes == 0 && grants.isEmpty && fulfilments.isEmpty;

  factory ChildRewardsSnapshot.fromJson(Map<String, dynamic> json) => ChildRewardsSnapshot(
        activeBonusMinutes: (json['activeBonusMinutes'] as num?)?.toInt(),
        grants: (json['screenTimeGrants'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(ChildScreenTimeGrant.fromJson)
            .toList(),
        fulfilments: (json['fulfilments'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(ChildFulfilment.fromJson)
            .toList(),
      );
}

/// The points/level account, from the pre-existing
/// `GET /life-intelligence/self/rewards/account`.
///
/// ONE CURRENCY, NOT TWO. F4's `POINTS` reward writes to the ledger as
/// `XP` (`REWARD_TYPE_TO_LEDGER`), so `xp` here IS the «نقطة» a goal card
/// promises. Audit PA-M-006 flagged the risk of a child seeing two
/// different balances for the same achievement; this is the resolution.
class ChildAccount {
  const ChildAccount({required this.points, required this.coins, required this.level});

  final int points;
  final int coins;
  final int level;

  factory ChildAccount.fromJson(Map<String, dynamic> json) => ChildAccount(
        points: (json['xp'] as num?)?.toInt() ?? 0,
        coins: (json['coins'] as num?)?.toInt() ?? 0,
        level: (json['level'] as num?)?.toInt() ?? 1,
      );
}
