import '../../../core/errors/api_failure.dart';
import '../application/device_registration_service.dart';

/// THE BOUNDARY IN FRONT OF THE FIRST CALL THIS APP EVER MAKES.
///
/// `PairingScreen` used to read `DeviceRegistrationService` directly, import
/// `ApiException`, and render `e.message` — the transport's own English,
/// status code and all — inside a coral box next to Sparky. On the very first
/// screen a child sees.
///
/// Same shape as `ChildCatalogueRepository`, `ChildCoachRepository` and
/// `ChildAchievementsRepository`: above this line nothing imports Dio, nothing
/// imports `ApiException`, and nothing loses `messageAr`. Below it, the
/// original text survives on `ApiFailure.diagnostic`, which no widget reads.
///
/// It catches `Object`, not `ApiException`: `registerWithCode` also touches
/// the platform channel and secure storage, and a `MissingPluginException` or
/// a `PlatformException` from one OEM's Keystore is exactly the kind of
/// developer artefact that must not become a sentence a child reads.
class ChildPairingRepository {
  ChildPairingRepository(this._registration);

  final DeviceRegistrationService _registration;

  /// Throws [ApiFailure] on any failure — never an `ApiException`, never a
  /// `PlatformException`. `ApiFailure.from` is idempotent, so a caller that
  /// converts again is harmless.
  Future<void> registerWithCode(String code) async {
    try {
      await _registration.registerWithCode(code);
    } catch (error) {
      throw ApiFailure.from(error);
    }
  }
}
