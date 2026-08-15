/// FULFILMENT and SCREEN-TIME GRANTS — the two things that turn a granted
/// reward into something that happened in the real world.
library;

class FulfilmentStatuses {
  FulfilmentStatuses._();

  static const String pending = 'PENDING';
  static const String approved = 'APPROVED';
  static const String fulfilled = 'FULFILLED';
  static const String declined = 'DECLINED';

  static const List<String> all = [pending, approved, fulfilled, declined];

  /// THE SERVER'S `FULFILMENT_TRANSITIONS`, mirrored for ONE reason: so
  /// the UI never renders a button for an illegal move.
  ///
  /// Audit P17 states the requirement exactly — "الانتقالات محدودة؛ يجب
  /// ألا تعرض الواجهة زرًّا لانتقال غير قانوني". The server still rejects
  /// an illegal transition with a 400 and a conditional UPDATE that cannot
  /// lose a race; this table only stops the parent from being offered the
  /// move in the first place.
  static const Map<String, List<String>> transitions = {
    pending: [approved, declined],
    approved: [fulfilled, declined],
    fulfilled: <String>[],
    declined: <String>[],
  };

  static List<String> nextFrom(String status) => transitions[status] ?? const [];

  static bool isTerminal(String status) => nextFrom(status).isEmpty;
}

class RewardFulfilment {
  const RewardFulfilment({
    required this.id,
    required this.childId,
    required this.rewardType,
    required this.description,
    required this.quantity,
    required this.status,
    this.achievementId,
    this.note,
    this.decidedAt,
    this.fulfilledAt,
    this.createdAt,
  });

  final String id;
  final String childId;
  final String? achievementId;
  final String rewardType;
  final String description;
  final int quantity;
  final String status;
  final String? note;
  final DateTime? decidedAt;
  final DateTime? fulfilledAt;
  final DateTime? createdAt;

  List<String> get allowedTransitions => FulfilmentStatuses.nextFrom(status);
  bool get isTerminal => FulfilmentStatuses.isTerminal(status);

  factory RewardFulfilment.fromJson(Map<String, dynamic> json) => RewardFulfilment(
        id: json['id']?.toString() ?? '',
        childId: json['childId']?.toString() ?? '',
        achievementId: json['achievementId']?.toString(),
        rewardType: json['rewardType']?.toString() ?? '',
        description: json['description']?.toString() ?? '',
        quantity: (json['quantity'] as num?)?.toInt() ?? 1,
        status: json['status']?.toString() ?? FulfilmentStatuses.pending,
        note: json['note']?.toString(),
        decidedAt: _parseDate(json['decidedAt']),
        fulfilledAt: _parseDate(json['fulfilledAt']),
        createdAt: _parseDate(json['createdAt']),
      );
}

/// A bounded, expiring, revocable grant of extra screen-time minutes.
/// Note what this is NOT: an edit to the child's screen-time policy. The
/// base policy row is untouched and this expires on its own.
class ScreenTimeGrant {
  const ScreenTimeGrant({
    required this.id,
    required this.childId,
    required this.minutes,
    this.grantedAt,
    this.expiresAt,
    this.revokedAt,
    this.achievementId,
  });

  final String id;
  final String childId;
  final int minutes;
  final DateTime? grantedAt;
  final DateTime? expiresAt;
  final DateTime? revokedAt;
  final String? achievementId;

  bool get isRevoked => revokedAt != null;

  /// Presentation-only: a grant past its `expiresAt` is already inert
  /// server-side (`activeBonusMinutes` filters on `expiresAt > now`); this
  /// only decides whether to grey the row.
  bool isExpiredAt(DateTime now) => expiresAt != null && !expiresAt!.isAfter(now);

  bool isActiveAt(DateTime now) => !isRevoked && !isExpiredAt(now);

  factory ScreenTimeGrant.fromJson(Map<String, dynamic> json) => ScreenTimeGrant(
        id: json['id']?.toString() ?? '',
        childId: json['childId']?.toString() ?? '',
        minutes: (json['minutes'] as num?)?.toInt() ?? 0,
        grantedAt: _parseDate(json['grantedAt']),
        expiresAt: _parseDate(json['expiresAt']),
        revokedAt: _parseDate(json['revokedAt']),
        achievementId: json['achievementId']?.toString(),
      );
}

/// The child's ledger-backed account, from the pre-existing
/// `GET /life-intelligence/rewards/:childId/account`.
///
/// REUSE, NOT A SECOND CURRENCY: F4's `POINTS` maps onto the existing
/// ledger type `XP` (`REWARD_TYPE_TO_LEDGER`), so the number a parent sees
/// here IS the number an F4 grant moved. Audit PA-M-006 flagged the risk of
/// showing two balances; this app shows one, and labels it «نقطة».
class RewardsAccount {
  const RewardsAccount({required this.xp, required this.coins, required this.level});

  final int xp;
  final int coins;
  final int level;

  factory RewardsAccount.fromJson(Map<String, dynamic> json) => RewardsAccount(
        xp: (json['xp'] as num?)?.toInt() ?? 0,
        coins: (json['coins'] as num?)?.toInt() ?? 0,
        level: (json['level'] as num?)?.toInt() ?? 1,
      );
}

DateTime? _parseDate(Object? value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString());
}
