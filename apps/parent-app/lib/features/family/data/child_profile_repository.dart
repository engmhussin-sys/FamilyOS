import '../../../core/errors/failure_boundary.dart';
import '../../../core/observability/failure_logger.dart';
import '../../dashboard/api/dashboard_api.dart';
import '../../pairing/api/pairing_api.dart';
import '../api/consent_api.dart';

/// A CONSENT ROW, AS THE SCREEN NEEDS IT.
///
/// `GET /children/:id/consents` returns `{consentType, granted, …}` and
/// `ManageConsentsScreen` reached into that map with two unguarded casts
/// inside a loop. A row missing either field — or carrying a `granted` the
/// backend later widens to a tri-state — turned into a `TypeError` that the
/// screen then displayed as raw exception text. Parsing here means a
/// malformed row is DROPPED and the rest of the screen still renders, which
/// on a compliance surface is strictly better than showing nothing.
class ChildConsent {
  const ChildConsent({required this.consentType, required this.granted});

  final String consentType;
  final bool granted;

  /// `null` for a row this build cannot read. The caller drops those.
  static ChildConsent? fromJson(Object? row) {
    if (row is! Map) return null;
    final type = row['consentType'];
    final granted = row['granted'];
    if (type is! String || type.isEmpty || granted is! bool) return null;
    return ChildConsent(consentType: type, granted: granted);
  }
}

/// THE BOUNDARY FOR THE TWO SCREENS THAT CREATE A CHILD AND THEN GOVERN WHAT
/// IS COLLECTED ABOUT THEM.
///
/// `CreateChildScreen` and `ManageConsentsScreen` sit either side of Sprint
/// 1's Option C — implicit grant at creation, explicit opt-out afterwards —
/// and both ended their `catch` with `e.toString()`. On the consents screen
/// that raw text was stored and then NOT rendered, which is the more
/// dangerous of the two shapes: nothing on screen looked wrong, and the leak
/// was one `Text(_errorMessage!)` away at all times.
///
/// It spans three APIs on purpose. The three calls belong to one parent-
/// facing concern — this child's profile and this child's consents — and
/// splitting them across three repositories to match the three API classes
/// would put the seam where the transport is rather than where the feature
/// is.
class ChildProfileRepository {
  ChildProfileRepository(
    this._dashboardApi,
    this._pairingApi,
    this._consentApi, {
    FailureLogger? logger,
  }) : _boundary = FailureBoundary(logger ?? const SentryFailureLogger());

  final DashboardApi _dashboardApi;
  final PairingApi _pairingApi;
  final ConsentApi _consentApi;
  final FailureBoundary _boundary;

  /// Returns the created child's id. The screen needs nothing else from the
  /// body, and returning the raw map would put an unguarded
  /// `child['id'] as String` back on the screen — which is where the crash
  /// that this class exists to stop used to live.
  ///
  /// Throws [ApiFailure] if the id is absent: a creation whose id the client
  /// cannot read is not a creation the client can follow up on, and pushing
  /// `null` down the consent call would fail later with a worse message.
  Future<String> createChild({
    required String firstName,
    required String dateOfBirth,
    String? lastName,
  }) =>
      _boundary.guard('createChild', () async {
        final body = await _dashboardApi.createChild(
          firstName: firstName,
          dateOfBirth: dateOfBirth,
          lastName: lastName,
        );
        final id = body['id'];
        if (id is! String || id.isEmpty) {
          throw const FormatException('POST /children returned no child id.');
        }
        return id;
      });

  Future<void> grantDefaultConsents(String childId) => _boundary.guard(
        'grantDefaultConsents',
        () => _pairingApi.grantDefaultConsents(childId),
      );

  /// The children a parent may pick between on the consents screen, as
  /// `{id, firstName}` pairs. Rows with no id are dropped — a dropdown entry
  /// that cannot identify a child is a dead selection.
  Future<List<ChildSummary>> listChildren() =>
      _boundary.guard('listChildren', () async {
        final rows = await _dashboardApi.getChildren();
        return rows
            .map(ChildSummary.fromJson)
            .whereType<ChildSummary>()
            .toList(growable: false);
      });

  /// ONE CHILD, FOR THE CHILD-DETAIL SCREEN.
  ///
  /// `GET /children/:childId`. Every failure that matters ends as an
  /// `ApiFailure` carrying the SERVER's own Arabic and never `e.toString()`:
  /// an id belonging to another family (404 `ChildNotFoundException`), an id
  /// that is well-shaped but names nothing, and a response whose shape this
  /// build cannot read.
  ///
  /// The last one throws rather than returning `null`, and that is the point:
  /// a detail screen that cannot name the child it is about would render a page
  /// of blanks with real buttons under them, and a parent tapping «وقت الشاشة»
  /// there would open a child-scoped screen for a child nobody identified.
  Future<ChildProfile> getChild(String childId) =>
      _boundary.guard('getChild', () async {
        final body = await _dashboardApi.getChild(childId);
        final profile = ChildProfile.fromJson(body);
        if (profile == null) {
          throw const FormatException(
            'GET /children/:childId returned no readable child.',
          );
        }
        return profile;
      });

  Future<List<ChildConsent>> listConsents(String childId) =>
      _boundary.guard('listConsents', () async {
        final rows = await _consentApi.listConsents(childId);
        return rows
            .map(ChildConsent.fromJson)
            .whereType<ChildConsent>()
            .toList(growable: false);
      });

  Future<void> setConsent(String childId, String consentType, bool granted) =>
      _boundary.guard(
        'setConsent',
        () => _consentApi.setConsent(childId, consentType, granted),
      );
}

/// The two fields the child picker needs, and nothing else.
class ChildSummary {
  const ChildSummary({required this.id, required this.firstName});

  final String id;

  /// May be empty — the screen falls back to a localised placeholder rather
  /// than rendering a blank dropdown row. `Text(c['firstName'] as String)`
  /// used to throw on a null one.
  final String firstName;

  static ChildSummary? fromJson(Object? row) {
    if (row is! Map) return null;
    final id = row['id'];
    if (id is! String || id.isEmpty) return null;
    final firstName = row['firstName'];
    return ChildSummary(
      id: id,
      firstName: firstName is String ? firstName : '',
    );
  }
}

/// ONE CHILD, AS THE DETAIL SCREEN NEEDS THEM — AND AS A WHITELIST.
///
/// `GET /children/:childId` returns the Prisma `Child` row as it stands, which
/// includes `familyId` (a tenant identifier), `pinCodeHash` (a hashed
/// credential for the child app's own login) and the soft-delete bookkeeping.
/// None of that belongs on a parent's screen, and the way to guarantee it never
/// arrives there is to name the fields that ARE wanted rather than to carry the
/// map and remember not to read the rest. Five keys, and adding a sixth is a
/// deliberate edit here rather than an accident on a widget.
///
/// [dateOfBirth] is kept because the screen shows an AGE IN YEARS, not a date:
/// a birthday on a monitoring screen is a piece of personal data with no job to
/// do, while an age tells a parent at a glance which of two children a screen
/// is about.
class ChildProfile {
  const ChildProfile({
    required this.id,
    required this.firstName,
    this.lastName,
    this.dateOfBirth,
    this.isActive = true,
  });

  final String id;

  /// May be empty. The screen falls back to a localised placeholder rather than
  /// rendering an empty app-bar title.
  final String firstName;

  final String? lastName;

  /// `null` when absent or unparseable — the screen then omits the age line
  /// rather than printing a wrong one.
  final DateTime? dateOfBirth;

  /// `Child.isActive`. A deactivated profile still opens; the screen says so.
  final bool isActive;

  /// Whole years, floored, computed against [now] so a test does not depend on
  /// the wall clock. `null` when [dateOfBirth] is unknown or in the future —
  /// a negative age is a data problem, not a number to show a parent.
  int? ageInYearsAt(DateTime now) {
    final born = dateOfBirth;
    if (born == null) return null;
    var years = now.year - born.year;
    final hadBirthday = now.month > born.month ||
        (now.month == born.month && now.day >= born.day);
    if (!hadBirthday) years -= 1;
    return years < 0 || years > 130 ? null : years;
  }

  static ChildProfile? fromJson(Object? row) {
    if (row is! Map) return null;
    final id = row['id'];
    if (id is! String || id.isEmpty) return null;

    final firstName = row['firstName'];
    final lastName = row['lastName'];
    final dateOfBirth = row['dateOfBirth'];
    final isActive = row['isActive'];

    return ChildProfile(
      id: id,
      firstName: firstName is String ? firstName : '',
      lastName: lastName is String && lastName.isNotEmpty ? lastName : null,
      dateOfBirth: dateOfBirth is String ? DateTime.tryParse(dateOfBirth) : null,
      isActive: isActive is bool ? isActive : true,
    );
  }
}
