import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:child_app/core/platform/agent_channel.dart';
import 'package:child_app/core/storage/secure_token_storage.dart';
import 'package:child_app/features/pairing/api/pairing_api.dart';
import 'package:child_app/features/pairing/application/device_registration_service.dart';
import 'package:child_app/features/pairing/domain/pairing.types.dart';

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
}

class _FakePairingApi implements PairingApi {
  RegistrationTicket? acceptResult;
  DeviceRegistrationResult? registerResult;
  String? lastAcceptedCode;
  Map<String, dynamic>? lastRegisterCall;

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
  Future<void> heartbeat() async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('DeviceRegistrationService', () {
    late _FakePairingApi fakeApi;
    late _FakeAgentPlatformChannel fakeChannel;
    late SecureTokenStorage tokenStorage;
    late DeviceRegistrationService service;

    setUp(() {
      fakeApi = _FakePairingApi();
      fakeChannel = _FakeAgentPlatformChannel();
      tokenStorage = SecureTokenStorage(_FakeSecureStorage());
      service = DeviceRegistrationService(fakeApi, fakeChannel, tokenStorage);
    });

    test('calls accept with the exact code provided', () async {
      fakeApi.acceptResult = const RegistrationTicket(token: 'reg-token', expiresInSeconds: 300);
      fakeApi.registerResult = const DeviceRegistrationResult(
        deviceId: 'device-1',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
      );

      await service.registerWithCode('ABCD-1234');

      expect(fakeApi.lastAcceptedCode, 'ABCD-1234');
    });

    test('passes the native public key and registration token through to registerDevice', () async {
      fakeApi.acceptResult = const RegistrationTicket(token: 'reg-token', expiresInSeconds: 300);
      fakeApi.registerResult = const DeviceRegistrationResult(
        deviceId: 'device-1',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
      );

      await service.registerWithCode('ABCD-1234');

      expect(fakeApi.lastRegisterCall!['registrationToken'], 'reg-token');
      expect(fakeApi.lastRegisterCall!['publicKey'], 'fake-base64-public-key');
      expect(fakeApi.lastRegisterCall!['platform'], 'ANDROID');
      expect(fakeApi.lastRegisterCall!['appVersion'], '0.1.0');
    });

    test('saves the resulting session in SecureTokenStorage', () async {
      fakeApi.acceptResult = const RegistrationTicket(token: 'reg-token', expiresInSeconds: 300);
      fakeApi.registerResult = const DeviceRegistrationResult(
        deviceId: 'device-1',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
      );

      await service.registerWithCode('ABCD-1234');

      expect(await tokenStorage.getAccessToken(), 'access-1');
      expect(await tokenStorage.getRefreshToken(), 'refresh-1');
      expect(await tokenStorage.getDeviceId(), 'device-1');
      expect(await tokenStorage.hasSession(), isTrue);
    });
  });
}
