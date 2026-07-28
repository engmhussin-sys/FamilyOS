class CachedPolicy {
  const CachedPolicy({
    required this.dailyLimitMinutes,
    required this.bedtimeStart,
    required this.bedtimeEnd,
    required this.focusModeEnabled,
    required this.syncedAt,
  });

  final int? dailyLimitMinutes;
  final String? bedtimeStart;
  final String? bedtimeEnd;
  final bool focusModeEnabled;
  final DateTime syncedAt;

  Map<String, dynamic> toJson() => {
        'dailyLimitMinutes': dailyLimitMinutes,
        'bedtimeStart': bedtimeStart,
        'bedtimeEnd': bedtimeEnd,
        'focusModeEnabled': focusModeEnabled,
        'syncedAt': syncedAt.toIso8601String(),
      };

  factory CachedPolicy.fromJson(Map<String, dynamic> json) => CachedPolicy(
        dailyLimitMinutes: json['dailyLimitMinutes'] as int?,
        bedtimeStart: json['bedtimeStart'] as String?,
        bedtimeEnd: json['bedtimeEnd'] as String?,
        focusModeEnabled: json['focusModeEnabled'] as bool? ?? false,
        syncedAt: DateTime.parse(json['syncedAt'] as String),
      );
}

/// Sprint 4 (Child Runtime Engine) §5 — "the child must still remain
/// protected" even after days offline. This is the ONE hardcoded
/// fallback the Runtime falls back to when nothing has ever synced —
/// deliberately conservative (a modest daily limit, a reasonable
/// bedtime window), not "no limits" just because the cache is empty.
final defaultOfflinePolicy = CachedPolicy(
  dailyLimitMinutes: 120,
  bedtimeStart: '21:00',
  bedtimeEnd: '07:00',
  focusModeEnabled: false,
  syncedAt: DateTime.fromMillisecondsSinceEpoch(0), // epoch — visibly "never really synced"
);
