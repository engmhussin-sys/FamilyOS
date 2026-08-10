import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/plugins/anti_tamper/contracts/i_anti_tamper.dart';

void main() {
  group('tamperSignalsToRiskSignalsDto', () {
    test('maps an empty signal list to all-false — "nothing detected," matching checkForTampering()\u2019s own contract', () {
      final result = tamperSignalsToRiskSignalsDto(const []);
      expect(result.values.every((v) => v == false), isTrue);
      expect(result.keys.toSet(), {
        'isEmulator',
        'isRooted',
        'hasTamperIndicators',
        'isUnsupportedDevice',
        'missingAttestation',
        'mockLocationEnabled',
        'developerModeEnabled',
        'usbDebuggingEnabled',
        'isOldAndroidVersion',
      });
    });

    test('maps emulatorDetected to isEmulator only', () {
      final result = tamperSignalsToRiskSignalsDto([TamperSignal.emulatorDetected]);
      expect(result['isEmulator'], isTrue);
      expect(result['isRooted'], isFalse);
    });

    test('maps rootDetected to isRooted only', () {
      final result = tamperSignalsToRiskSignalsDto([TamperSignal.rootDetected]);
      expect(result['isRooted'], isTrue);
      expect(result['isEmulator'], isFalse);
    });

    test('accessibilityDisabled and usageAccessDisabled both set hasTamperIndicators', () {
      expect(tamperSignalsToRiskSignalsDto([TamperSignal.accessibilityDisabled])['hasTamperIndicators'], isTrue);
      expect(tamperSignalsToRiskSignalsDto([TamperSignal.usageAccessDisabled])['hasTamperIndicators'], isTrue);
    });

    test('mockLocationDetected, developerModeEnabled, usbDebuggingEnabled map to their own distinct fields', () {
      final result = tamperSignalsToRiskSignalsDto([
        TamperSignal.mockLocationDetected,
        TamperSignal.developerModeEnabled,
        TamperSignal.usbDebuggingEnabled,
      ]);
      expect(result['mockLocationEnabled'], isTrue);
      expect(result['developerModeEnabled'], isTrue);
      expect(result['usbDebuggingEnabled'], isTrue);
      expect(result['isRooted'], isFalse);
    });

    test('isUnsupportedDevice and isOldAndroidVersion are honestly false, not guessed — no real minSdkVersion exists yet to compare against', () {
      final result = tamperSignalsToRiskSignalsDto(TamperSignal.values);
      expect(result['isUnsupportedDevice'], isFalse);
      expect(result['isOldAndroidVersion'], isFalse);
    });

    test('missingAttestation is always false from this mapping — decided separately by whether attestationChain was sent', () {
      final result = tamperSignalsToRiskSignalsDto(TamperSignal.values);
      expect(result['missingAttestation'], isFalse);
    });

    test('combines multiple independent signals correctly, matching a plausible real device state', () {
      final result = tamperSignalsToRiskSignalsDto([
        TamperSignal.rootDetected,
        TamperSignal.usbDebuggingEnabled,
        TamperSignal.accessibilityDisabled,
      ]);
      expect(result['isRooted'], isTrue);
      expect(result['usbDebuggingEnabled'], isTrue);
      expect(result['hasTamperIndicators'], isTrue);
      expect(result['isEmulator'], isFalse);
      expect(result['mockLocationEnabled'], isFalse);
    });
  });
}
