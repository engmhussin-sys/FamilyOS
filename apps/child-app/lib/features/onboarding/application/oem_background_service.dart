import '../../../core/platform/agent_channel.dart';

/// Typed view over the native `OemBackgroundRestrictionManager`
/// (F2 — audit verdict risk R7).
///
/// Exists so the widget layer never touches the raw
/// `Map<Object?, Object?>` the platform channel returns, and so an
/// unknown manufacturer resolves to a defined value here rather than to a
/// null dereference three layers up.
class OemBackgroundInfo {
  const OemBackgroundInfo({
    required this.manufacturer,
    required this.oemKey,
    required this.hasOemIntent,
    required this.batteryExempt,
  });

  /// Every value the native side can return. Kept as a list so the UI can
  /// map an unknown key to [generic] instead of showing a raw string or
  /// crashing on a manufacturer nobody anticipated.
  static const List<String> knownOemKeys = <String>[
    'xiaomi',
    'oppo',
    'vivo',
    'huawei',
    'samsung',
    'transsion',
    'generic',
  ];

  static const String generic = 'generic';

  final String manufacturer;
  final String oemKey;
  final bool hasOemIntent;
  final bool batteryExempt;

  /// True when this device is one of the skins known to kill background
  /// services outside AOSP rules — i.e. when the step is worth showing
  /// proactively rather than leaving in the diagnostics list.
  bool get needsAttention => oemKey != generic || !batteryExempt;

  /// Localisation key for the vendor-specific instructions.
  String get stepsKey => 'oem.step.$oemKey';

  static OemBackgroundInfo fromMap(Map<Object?, Object?> raw) {
    final key = raw['oemKey']?.toString() ?? generic;
    return OemBackgroundInfo(
      manufacturer: raw['manufacturer']?.toString() ?? '',
      oemKey: knownOemKeys.contains(key) ? key : generic,
      hasOemIntent: raw['hasOemIntent'] == true,
      batteryExempt: raw['batteryExempt'] == true,
    );
  }

  static const OemBackgroundInfo unknown = OemBackgroundInfo(
    manufacturer: '',
    oemKey: generic,
    hasOemIntent: false,
    batteryExempt: false,
  );
}

class OemBackgroundService {
  OemBackgroundService(this._channel);

  final AgentPlatformChannel _channel;

  /// Never throws. A device whose native side does not implement these
  /// methods (an older build of the APK, or a future iOS target) must not
  /// break onboarding — it simply gets [OemBackgroundInfo.unknown], and
  /// the screen degrades to the generic advice.
  Future<OemBackgroundInfo> load() async {
    try {
      return OemBackgroundInfo.fromMap(
        await _channel.getOemBackgroundRestrictionInfo(),
      );
    } catch (_) {
      return OemBackgroundInfo.unknown;
    }
  }

  /// Returns the id of the screen that actually opened, mapped to the
  /// matching localisation key so the caller can tell the user what they
  /// are looking at. Returns `oem.openedNone` if nothing opened at all.
  Future<String> openSettingsAndDescribe() async {
    String opened;
    try {
      opened = await _channel.openOemBackgroundSettings();
    } catch (_) {
      opened = 'none';
    }
    return switch (opened) {
      'oem_autostart' => 'oem.openedOemAutostart',
      'battery_optimization' => 'oem.openedBatteryOptimization',
      'app_details' => 'oem.openedAppDetails',
      _ => 'oem.openedNone',
    };
  }
}
