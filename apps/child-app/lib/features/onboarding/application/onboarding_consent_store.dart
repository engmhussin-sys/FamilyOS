import 'package:shared_preferences/shared_preferences.dart';

/// Where the first-run prominent-disclosure acknowledgement is recorded
/// (F2 — Play User Data policy, audit A3 §4/P2 and verdict risk R5).
///
/// Kept behind an interface for the same reason [LocaleStorage] is:
/// `SharedPreferences` needs a platform channel, so a widget test that
/// merely builds a screen would otherwise have to stand up a mock channel.
///
/// NO NEW DEPENDENCY: `shared_preferences` is already in pubspec.yaml
/// (added by F1 for the locale). This deliberately reuses it rather than
/// introducing a second persistence mechanism for one boolean.
///
/// WHY NOT flutter_secure_storage: an acknowledgement is not a secret, and
/// the Keystore-backed store is reserved for the device-bound refresh
/// token (Decision-012). Same reasoning as the locale.
///
/// WHAT THIS IS NOT: it is a LOCAL record that the screen was shown and
/// acknowledged on this device. It is not the family's legal
/// `ParentalConsent` record, which lives in the backend (audit A2 §3.1)
/// and is granted by the parent in the parent app. Syncing this local
/// acknowledgement to that record is a separate, still-open item — see
/// docs/release/PLAY_POLICY_DECLARATION.md.
abstract class OnboardingConsentStore {
  Future<bool> hasAcknowledgedDisclosure();

  Future<void> setDisclosureAcknowledged();

  /// Whether the OEM background-restriction step has been walked through
  /// (or explicitly skipped). Only controls whether the step is offered
  /// again automatically; the screen is always reachable manually.
  Future<bool> hasCompletedOemStep();

  Future<void> setOemStepCompleted();
}

class SharedPreferencesOnboardingConsentStore implements OnboardingConsentStore {
  const SharedPreferencesOnboardingConsentStore();

  static const String disclosureKey = 'abny.consent.disclosureAcknowledgedV1';
  static const String oemStepKey = 'abny.onboarding.oemStepCompletedV1';

  /// The `V1` suffix is load-bearing: if the disclosure copy ever changes
  /// materially (a new data field is collected), the key must be bumped so
  /// every existing install is shown the new text. A disclosure the user
  /// never saw is not a disclosure.
  @override
  Future<bool> hasAcknowledgedDisclosure() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(disclosureKey) ?? false;
  }

  @override
  Future<void> setDisclosureAcknowledged() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(disclosureKey, true);
  }

  @override
  Future<bool> hasCompletedOemStep() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(oemStepKey) ?? false;
  }

  @override
  Future<void> setOemStepCompleted() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(oemStepKey, true);
  }
}

/// Test double — no platform channel, no async I/O of consequence.
class InMemoryOnboardingConsentStore implements OnboardingConsentStore {
  InMemoryOnboardingConsentStore({
    bool disclosureAcknowledged = false,
    bool oemStepCompleted = false,
  })  : _disclosure = disclosureAcknowledged,
        _oem = oemStepCompleted;

  bool _disclosure;
  bool _oem;

  @override
  Future<bool> hasAcknowledgedDisclosure() async => _disclosure;

  @override
  Future<void> setDisclosureAcknowledged() async => _disclosure = true;

  @override
  Future<bool> hasCompletedOemStep() async => _oem;

  @override
  Future<void> setOemStepCompleted() async => _oem = true;
}
