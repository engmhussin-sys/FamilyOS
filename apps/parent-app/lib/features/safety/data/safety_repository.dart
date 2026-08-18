import '../../../core/errors/failure_boundary.dart';
import '../../../core/observability/failure_logger.dart';
import '../../dashboard/api/dashboard_api.dart';
import '../../family/data/child_profile_repository.dart';
import '../../notifications/api/notifications_api.dart';
import '../domain/safety_event.dart';

/// THE BOUNDARY FOR THE SAFETY SURFACE.
///
/// Same shape as every repository added since `LifeIntelligenceRepository`:
/// one [FailureBoundary], so `ApiException` becomes `ApiFailure` exactly once,
/// the ORIGINAL error plus its stack reaches the crash reporter on the way
/// past, and nothing above this line can end a `catch` with `e.toString()`.
///
/// IT ADDS NO ENDPOINT. Both calls go through APIs that already exist and are
/// already used by other screens — `NotificationsApi.list()` is the inbox's own
/// call, `DashboardApi.getChildren()` is the dashboard's. That is deliberate:
/// this product's rule is one caller per route, and a safety screen that
/// invented a `/safety/...` client for a route the backend does not serve would
/// be a screen that cannot work.
class SafetyRepository {
  SafetyRepository(
    this._notificationsApi,
    this._dashboardApi, {
    FailureLogger? logger,
  }) : _boundary = FailureBoundary(logger ?? const SentryFailureLogger());

  final NotificationsApi _notificationsApi;
  final DashboardApi _dashboardApi;
  final FailureBoundary _boundary;

  /// The parent's safety-class notifications, newest first — which is the order
  /// `PrismaNotificationRepository.listForUser` already returns
  /// (`orderBy: { createdAt: 'desc' }`), so nothing here re-sorts and nothing
  /// here can disagree with the inbox about what «latest» means.
  ///
  /// A row that is not a parent safety event, or that this build cannot read,
  /// is DROPPED by [SafetyEvent.fromJson] rather than rendered as a blank card.
  Future<List<SafetyEvent>> listSafetyEvents() =>
      _boundary.guard('listSafetyEvents', () async {
        final rows = await _notificationsApi.list();
        return rows
            .map(SafetyEvent.fromJson)
            .whereType<SafetyEvent>()
            .toList(growable: false);
      });

  /// `childId -> firstName`, for putting a NAME on an event instead of an id.
  ///
  /// Called separately from [listSafetyEvents], and the controller treats a
  /// failure here as decoration lost rather than as a failed screen: a parent
  /// whose `GET /children` call fails must still be shown the alert. Children
  /// with no readable id, or an empty name, are simply absent from the map.
  Future<Map<String, String>> childNamesById() =>
      _boundary.guard('safetyChildNames', () async {
        final rows = await _dashboardApi.getChildren();
        final names = <String, String>{};
        for (final row in rows) {
          final summary = ChildSummary.fromJson(row);
          if (summary != null && summary.firstName.isNotEmpty) {
            names[summary.id] = summary.firstName;
          }
        }
        return names;
      });
}
