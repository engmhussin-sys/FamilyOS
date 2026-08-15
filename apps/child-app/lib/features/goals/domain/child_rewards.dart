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

  bool isActiveAt(DateTime now) =>
      revokedAt == null && (expiresAt == null || expiresAt!.isAfter(now));

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
/// fulfilments}`. The bonus-minute total is computed SERVER-SIDE over
/// unexpired, unrevoked grants; the client displays it and does not re-add
/// the list itself.
class ChildRewardsSnapshot {
  const ChildRewardsSnapshot({
    required this.activeBonusMinutes,
    required this.grants,
    required this.fulfilments,
  });

  final int activeBonusMinutes;
  final List<ChildScreenTimeGrant> grants;
  final List<ChildFulfilment> fulfilments;

  bool get isEmpty => activeBonusMinutes == 0 && grants.isEmpty && fulfilments.isEmpty;

  factory ChildRewardsSnapshot.fromJson(Map<String, dynamic> json) => ChildRewardsSnapshot(
        activeBonusMinutes: (json['activeBonusMinutes'] as num?)?.toInt() ?? 0,
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
