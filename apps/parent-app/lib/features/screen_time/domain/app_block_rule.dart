/// APP BLOCK RULES, AND THE CATALOGUE THAT MAKES THEM PICKABLE.
///
/// The two halves of one job. `AppBlockRule` names a package; `AppCatalogEntry`
/// is how a parent finds out which package names actually exist on their
/// child's devices. Before `GET /children/:childId/apps` existed a parent could
/// only block an app by typing `com.example.thing` from memory, which is not a
/// feature anyone can use.
library;

/// The DTO's `@IsIn(['BLOCK', 'ALLOW', 'TIME_LIMIT'])`, transcribed from
/// `create-app-block-rule.dto.ts`. Mirrored so the UI never offers a fourth.
class AppRuleTypes {
  AppRuleTypes._();

  static const String block = 'BLOCK';
  static const String allow = 'ALLOW';
  static const String timeLimit = 'TIME_LIMIT';

  static const List<String> all = [block, allow, timeLimit];

  /// `ScreenTimeService.createAppBlockRule` refuses a `TIME_LIMIT` with no
  /// `limitMinutes` — a real business rule, not a DTO nicety, so the form
  /// asks for the number instead of collecting a 400.
  static bool requiresLimitMinutes(String ruleType) => ruleType == timeLimit;
}

/// `CreateAppBlockRuleDto`'s bounds, field by field:
///
/// ```ts
/// @IsString() @Length(1, 200)  packageName?: string;
/// @IsString() @Length(1, 50)   category?: string;
/// @IsIn([...])                 ruleType!: 'BLOCK' | 'ALLOW' | 'TIME_LIMIT';
/// @IsInt() @Min(1) @Max(1440)  limitMinutes?: number;
/// @IsObject()                  schedule?: Record<string, unknown>;
/// ```
///
/// Plus the ONE rule that lives in the service rather than the DTO and would
/// otherwise reach a parent as an English 400: exactly one of `packageName` /
/// `category`, «not both or neither».
class AppBlockRuleLimits {
  AppBlockRuleLimits._();

  static const int maxPackageNameLength = 200;
  static const int maxCategoryLength = 50;

  /// `@Min(1)` — a `TIME_LIMIT` of zero minutes is a `BLOCK`, and the DTO says
  /// so by refusing it.
  static const int minLimitMinutes = 1;
  static const int maxLimitMinutes = 1440;

  static bool isValidLimitMinutes(int? minutes) =>
      minutes != null && minutes >= minLimitMinutes && minutes <= maxLimitMinutes;
}

/// One rule, as `GET /children/:childId/app-block-rules` returns it —
/// `IAppBlockRule`: `{id, childId, packageName, category, ruleType,
/// limitMinutes, schedule, isActive}`.
///
/// The route lists ACTIVE rules only (`listActiveByChild`), so [isActive] is
/// carried but never used to filter here; it is parsed because the field is on
/// the wire and dropping it would make a future inactive row invisible rather
/// than visible-and-marked.
class AppBlockRule {
  const AppBlockRule({
    required this.id,
    required this.childId,
    required this.ruleType,
    this.packageName,
    this.category,
    this.limitMinutes,
    this.isActive = true,
  });

  final String id;
  final String childId;
  final String ruleType;

  /// Exactly one of these two is non-null — the service enforces it on create.
  final String? packageName;
  final String? category;

  final int? limitMinutes;
  final bool isActive;

  bool get targetsCategory => category != null && category!.isNotEmpty;

  /// The raw target string. NEVER a localised label: a package name is an
  /// identifier and translating it would make it stop matching what the device
  /// enforces. Rendered LTR for the same reason.
  String get target => targetsCategory ? category! : (packageName ?? '');

  factory AppBlockRule.fromJson(Map<String, dynamic> json) => AppBlockRule(
        id: json['id']?.toString() ?? '',
        childId: json['childId']?.toString() ?? '',
        ruleType: json['ruleType']?.toString() ?? AppRuleTypes.block,
        packageName: _nonEmpty(json['packageName']),
        category: _nonEmpty(json['category']),
        limitMinutes: (json['limitMinutes'] as num?)?.toInt(),
        isActive: json['isActive'] != false,
      );
}

/// One app the child's device has actually reported, as
/// `GET /children/:childId/apps` returns it. The response is
/// `{ "items": [ … ] }`, ordered most-recently-used first and capped at 500
/// (`APP_CATALOG_PARENT_RESULT_CAP`), and the fields are exactly
/// `APP_CATALOG_CLIENT_SELECT`'s: `id, packageName, appName, category,
/// iconUrl, firstSeenAt, lastUsedAt`. There is no `deviceId` and no `familyId`
/// on this path — the repository does not even read those columns.
class AppCatalogEntry {
  const AppCatalogEntry({
    required this.id,
    required this.packageName,
    required this.appName,
    this.category,
    this.iconUrl,
    this.firstSeenAt,
    this.lastUsedAt,
  });

  final String id;
  final String packageName;

  /// The device's own label for the app. May be empty on a malformed row, in
  /// which case the picker falls back to the package name rather than to a
  /// blank line.
  final String appName;

  final String? category;

  /// ALWAYS `https:` OR NULL — asserted server-side. Checked again here
  /// because a client that renders whatever string arrives in an `Image.network`
  /// is one bad row away from a cleartext request, and this app ships with a
  /// network-security config that forbids exactly that.
  final String? iconUrl;

  final DateTime? firstSeenAt;
  final DateTime? lastUsedAt;

  /// What the picker shows as the app's name.
  String get displayName => appName.trim().isEmpty ? packageName : appName.trim();

  /// `true` only for a URL this app is willing to load. Anything else — a
  /// `http:` row, a `data:` row, a relative path — renders as the fallback
  /// glyph, silently and safely.
  bool get hasSafeIcon {
    final url = iconUrl;
    return url != null && url.startsWith('https://');
  }

  factory AppCatalogEntry.fromJson(Map<String, dynamic> json) => AppCatalogEntry(
        id: json['id']?.toString() ?? '',
        packageName: json['packageName']?.toString() ?? '',
        appName: json['appName']?.toString() ?? '',
        category: _nonEmpty(json['category']),
        iconUrl: _nonEmpty(json['iconUrl']),
        firstSeenAt: _parseDate(json['firstSeenAt']),
        lastUsedAt: _parseDate(json['lastUsedAt']),
      );
}

String? _nonEmpty(Object? value) {
  if (value == null) return null;
  final text = value.toString().trim();
  return text.isEmpty ? null : text;
}

DateTime? _parseDate(Object? value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString());
}
