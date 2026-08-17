// WHAT THIS FILE PROVES — family creation actually persists the family's
// calendar.
//
// The defect it locks down: `CreateFamilyScreen` collected a country and a
// child count, and `FamilyApi.setupFamily` sent `{'name': ...}` and nothing
// else. `Family.timezone` therefore kept its schema default of `"UTC"`
// (`apps/backend/prisma/schema.prisma`, `model Family`) for the life of the
// family, and `FamilyDateService` derives every business date from that
// column — streak boundaries, daily limits, reward idempotency keys. A
// wrong zone is not a display bug; it moves the family's whole day.
//
// WHY `country` IS ASSERTED *ABSENT* RATHER THAN PRESENT.
// `UpdateSettingsDto` (settings/presentation/dto/update-settings.dto.ts)
// declares exactly `name?` and `timezone?`. `common/http/global-pipeline.ts`
// builds the global ValidationPipe with `forbidNonWhitelisted: true`, so an
// extra `country` key would make `PATCH /settings` answer 400 and break
// family creation entirely. Sending it is not "harmless extra data" — it is
// an outage. The country's only job is choosing the timezone, and the test
// below pins that mapping to the backend's own values.
//
// EXECUTION STATUS: NEVER RUN. No Flutter SDK is reachable from the
// environment this was authored in. STATIC VERIFIED by
// `scripts/dart_preflight.py` (constructor arity, named parameters, member
// references, import scope) only — that script is not a Dart analyser and
// executes nothing. First execution happens on a CI runner.

import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/network/api_client.dart';
import 'package:parent_app/features/family/api/family_api.dart';

/// Captures the one call this API makes. `implements` + `noSuchMethod` is
/// the same codegen-free pattern `test/support/reward_test_harness.dart`
/// already uses; anything the API starts calling that is not stubbed here
/// throws with its own name in the message instead of passing silently.
class _CapturingApiClient implements ApiClient {
  String? capturedPath;
  Map<String, dynamic>? capturedBody;

  @override
  Future<Map<String, dynamic>> patch(String path, {Object? data}) async {
    capturedPath = path;
    capturedBody = data as Map<String, dynamic>?;
    return <String, dynamic>{'id': 'fam_1'};
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        '_CapturingApiClient has no stub for ${invocation.memberName} — '
        'FamilyApi should only be calling PATCH /settings.',
      );
}

void main() {
  group('familyTimezoneByCountry — the backend\'s own values, not ours', () {
    test('Egypt resolves to Africa/Cairo', () {
      expect(timezoneForCountry('EG'), 'Africa/Cairo');
    });

    test('Saudi Arabia resolves to Asia/Riyadh', () {
      expect(timezoneForCountry('SA'), 'Asia/Riyadh');
    });

    test('an unknown country resolves to null, never to a defaulted zone', () {
      // A defaulted 'Africa/Cairo' here would silently give a Saudi family
      // the wrong day boundary — the exact class of bug this mapping is
      // meant to close. `null` means "send no timezone", which leaves the
      // family's current value untouched.
      expect(timezoneForCountry('AE'), isNull);
      expect(timezoneForCountry(null), isNull);
    });

    test('both launch markets are offered by the setup screen', () {
      expect(supportedFamilyCountries, containsAll(<String>['EG', 'SA']));
      for (final code in supportedFamilyCountries) {
        expect(
          familyTimezoneByCountry.containsKey(code),
          isTrue,
          reason: 'Country $code is offered in the UI but has no timezone, so '
              'picking it would send no timezone at all.',
        );
      }
    });
  });

  group('FamilyApi.buildSetupBody — the exact JSON PATCH /settings receives', () {
    test('an Egyptian family sends name + Africa/Cairo', () {
      final body = FamilyApi.buildSetupBody(name: 'عائلة حسين', countryCode: 'EG');

      expect(body['name'], 'عائلة حسين');
      expect(body['timezone'], 'Africa/Cairo');
    });

    test('a Saudi family sends name + Asia/Riyadh', () {
      final body = FamilyApi.buildSetupBody(name: 'عائلة العتيبي', countryCode: 'SA');

      expect(body['name'], 'عائلة العتيبي');
      expect(body['timezone'], 'Asia/Riyadh');
    });

    test('the body carries no key UpdateSettingsDto would reject', () {
      final body = FamilyApi.buildSetupBody(name: 'عائلة', countryCode: 'EG');

      // forbidNonWhitelisted: true — anything outside {name, timezone} is a
      // 400, so the body's key set is asserted exactly, not just sampled.
      expect(body.keys.toSet(), <String>{'name', 'timezone'});
      expect(body.containsKey('country'), isFalse);
      expect(body.containsKey('numberOfChildren'), isFalse);
      expect(body.containsKey('locale'), isFalse);
    });

    test('an unknown country omits timezone rather than guessing one', () {
      final body = FamilyApi.buildSetupBody(name: 'عائلة', countryCode: 'ZZ');

      expect(body.containsKey('timezone'), isFalse);
      expect(body['name'], 'عائلة');
    });
  });

  group('FamilyApi.setupFamily — what actually goes on the wire', () {
    test('PATCHes /settings with the derived Egyptian timezone', () async {
      final client = _CapturingApiClient();

      await FamilyApi(client).setupFamily(name: 'عائلة حسين', countryCode: 'EG');

      expect(client.capturedPath, '/settings');
      expect(client.capturedBody, <String, dynamic>{
        'name': 'عائلة حسين',
        'timezone': 'Africa/Cairo',
      });
    });

    test('PATCHes /settings with the derived Saudi timezone', () async {
      final client = _CapturingApiClient();

      await FamilyApi(client).setupFamily(name: 'عائلة العتيبي', countryCode: 'SA');

      expect(client.capturedPath, '/settings');
      expect(client.capturedBody, <String, dynamic>{
        'name': 'عائلة العتيبي',
        'timezone': 'Asia/Riyadh',
      });
    });
  });
}
