/// FULFILMENT — the half of a granted reward that has to happen in the real
/// world.
///
/// SCREEN-TIME GRANTS USED TO LIVE HERE TOO, as a second class describing the
/// same `screen_time_reward_grant` row that
/// `screen_time/domain/screen_time_policy.dart` already described. One model
/// now, in that file, because this app read one row through two routes and
/// gave the two readings different answers about whether a grant was live.
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
