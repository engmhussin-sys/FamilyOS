/// Decision-016's `ILocationCollector`. Placed under plugins/gps.
///
/// Not yet scheduled in the current 12-step build order (Decision-013) —
/// included here only because Decision-016 named it explicitly as a
/// required interface. Its concrete implementation and exact build step
/// should be scheduled in a future decision, not assumed.
abstract class ILocationCollector {
  /// Only ever called if ParentalConsent for LOCATION_TRACKING is active
  /// for this child (see apps/backend's ParentalConsent table) — consent
  /// enforcement happens server-side (ConsentService), but the Agent must
  /// also refuse to collect locally if it has no evidence consent was
  /// granted, per this project's defense-in-depth privacy pattern.
  Future<LocationSample?> getCurrentLocation();

  Stream<LocationSample> get locationUpdates;
}

class LocationSample {
  const LocationSample({
    required this.latitude,
    required this.longitude,
    required this.accuracyMeters,
    required this.capturedAt,
  });

  final double latitude;
  final double longitude;
  final double accuracyMeters;
  final DateTime capturedAt;
}
