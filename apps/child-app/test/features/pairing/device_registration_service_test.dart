import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:child_app/core/platform/agent_channel.dart';
import 'package:child_app/core/storage/secure_token_storage.dart';
import 'package:child_app/features/pairing/api/pairing_api.dart';
import 'package:child_app/features/pairing/application/device_registration_service.dart';
import 'package:child_app/features/pairing/domain/pairing.types.dart';
import 'package:child_app/plugins/anti_tamper/contracts/i_anti_tamper.dart';

/// Same in-memory fake pattern as
/// test/core/storage/secure_token_storage_test.dart.
class _FakeSecureStorage implements FlutterSecureStorage {
  final Map<String, String> _values = {};

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _values[key];

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      _values.remove(key);
    } else {
      _values[key] = value;
    }
  }

  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    _values.remove(key);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeAgentPlatformChannel implements AgentPlatformChannel {
  @override
  Future<String> getDevicePublicKey() async => 'fake-base64-public-key';

  @override
  Future<int> getAndroidSdkInt() async => 34;

  @override
  Future<String> getNativeAppVersion() async => '0.1.0';

  // PHASE E (IMPLEMENTS-MISSING). `AgentPlatformChannel` declares 24 members
  // and this fake declares three, so without this the class is a
  // `non_abstract_class_inherits_abstract_member` COMPILE ERROR and the whole
  // test file fails to build — not a runtime surprise, a build stop.
  //
  // Every other fake of this port in this repository already carried this
  // line (runtime_coordinator_test, runtime_telemetry_collector_test, all
  // three fakes in digital_wellbeing_service_test, and `_FakePairingApi` and
  // `_FakeSecureStorage` in this very file). This one was the single
  // omission; the fix is the file's own established pattern, not a new one.
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakePairingApi implements PairingApi {
  RegistrationTicket? acceptResult;
  DeviceRegistrationResult? registerResult;
  String? lastAcceptedCode;
  Map<String, dynamic>? lastRegisterCall;
  Map<String, bool>? lastVerifyRiskSignals;
  bool throwOnVerify = false;

  @override
  Future<RegistrationTicket> accept(String code) async {
    lastAcceptedCode = code;
    return acceptResult!;
  }

  @override
  Future<DeviceRegistrationResult> registerDevice({
    required String registrationToken,
    required String publicKey,
    required String platform,
    String? deviceModel,
    String? osVersion,
    String? appVersion,
    String? pairingProtocolVersion,
  }) async {
    lastRegisterCall = {
      'registrationToken': registrationToken,
      'publicKey': publicKey,
      'platform': platform,
      'appVersion': appVersion,
    };
    return registerResult!;
  }

  @override
  Future<void> heartbeat({
    int? batteryPercent,
    bool? isConnected,
    bool? accessibilityServiceEnabled,
    bool? enforcementActive,
  }) async {}

  @override
  Future<void> verify({required Map<String, bool> riskSignals}) async {
    if (throwOnVerify) {
      throw Exception('simulated platform-channel failure');
    }
    lastVerifyRiskSignals = riskSignals;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeAntiTamper implements IAntiTamper {
  List<TamperSignal> signalsToReturn = const [];
  bool throwOnCheck = false;

  @override
  Future<List<TamperSignal>> checkForTampering() async {
    if (throwOnCheck) {
      throw Exception('simulated native channel failure');
    }
    return signalsToReturn;
  }

  @override
  Stream<TamperSignal> get signalDetected => const Stream.empty();
}

void main() {
  group('DeviceRegistrationService', () {
    late _FakePairingApi fakeApi;
    late _FakeAgentPlatformChannel fakeChannel;
    late SecureTokenStorage tokenStorage;
    late _FakeAntiTamper fakeAntiTamper;
    late DeviceRegistrationService service;

    setUp(() {
      fakeApi = _FakePairingApi();
      fakeChannel = _FakeAgentPlatformChannel();
      tokenStorage = SecureTokenStorage(_FakeSecureStorage());
      fakeAntiTamper = _FakeAntiTamper();
      service = DeviceRegistrationService(fakeApi, fakeChannel, tokenStorage, fakeAntiTamper);
      fakeApi.acceptResult = const RegistrationTicket(token: 'reg-token', expiresInSeconds: 300);
      fakeApi.registerResult = const DeviceRegistrationResult(
        deviceId: 'device-1',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
      );
    });

    test('calls accept with the exact code provided', () async {
      await service.registerWithCode('ABCD-1234');
      expect(fakeApi.lastAcceptedCode, 'ABCD-1234');
    });

    test('passes the native public key and registration token through to registerDevice', () async {
      await service.registerWithCode('ABCD-1234');

      expect(fakeApi.lastRegisterCall!['registrationToken'], 'reg-token');
      expect(fakeApi.lastRegisterCall!['publicKey'], 'fake-base64-public-key');
      expect(fakeApi.lastRegisterCall!['platform'], 'ANDROID');
      expect(fakeApi.lastRegisterCall!['appVersion'], '0.1.0');
    });

    test('saves the resulting session in SecureTokenStorage', () async {
      await service.registerWithCode('ABCD-1234');

      expect(await tokenStorage.getAccessToken(), 'access-1');
      expect(await tokenStorage.getRefreshToken(), 'refresh-1');
      expect(await tokenStorage.getDeviceId(), 'device-1');
      expect(await tokenStorage.hasSession(), isTrue);
    });

    // --- Sprint 23 hardening: the real gap this session closed ---

    test('calls /pairing/verify with the mapped risk signals after a successful registration', () async {
      fakeAntiTamper.signalsToReturn = [TamperSignal.rootDetected, TamperSignal.developerModeEnabled];

      await service.registerWithCode('ABCD-1234');

      expect(fakeApi.lastVerifyRiskSignals, isNotNull);
      expect(fakeApi.lastVerifyRiskSignals!['isRooted'], isTrue);
      expect(fakeApi.lastVerifyRiskSignals!['developerModeEnabled'], isTrue);
      expect(fakeApi.lastVerifyRiskSignals!['isEmulator'], isFalse);
    });

    test('a failure in checkForTampering() never blocks pairing from completing', () async {
      fakeAntiTamper.throwOnCheck = true;

      // Must NOT throw — pairing succeeding matters more than this
      // one risk snapshot being perfectly timed (see the service's own comment).
      await service.registerWithCode('ABCD-1234');

      expect(await tokenStorage.hasSession(), isTrue);
      expect(fakeApi.lastVerifyRiskSignals, isNull);
    });

    test('a failure in verify() itself never blocks pairing from completing', () async {
      fakeApi.throwOnVerify = true;

      await service.registerWithCode('ABCD-1234');

      expect(await tokenStorage.hasSession(), isTrue);
    });
  });
}
