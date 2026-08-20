import '../../../core/network/api_client.dart';

/// THE CHILD'S OWN CATALOGUE — `GET /api/v1/self/catalogue/domains`.
///
/// `ChildCatalogueController`, `DeviceJwtAuthGuard`, `@ChildSurface`,
/// throttled 60/min. Every handler on that controller is a `@Get` with no
/// body, no query and no param: the child is derived from the DEVICE in the
/// verified token, so there is no channel here through which a device could
/// propose an age, a points figure or a limit. This class sends no
/// identifier for the same reason `ChildCoachApi` sends none.
///
/// ---------------------------------------------------------------------------
/// WHY THE SIBLING ROUTE `GET /self/catalogue` IS NOT CALLED — a decision,
/// not an omission.
///
/// That route returns the same domains WITH their `items[]`: every activity
/// the product knows about, each carrying `titleAr`, `estimatedDurationMinutes`,
/// a verification method and `reward.suggestedAmount`. Rendering them under
/// this chooser would put cards that look exactly like today's goals — a
/// title, a duration, a points badge — next to goals a child can actually
/// start. The difference between the two is invisible on a phone screen and
/// meaningless to a six-year-old: both are a tappable Arabic sentence with a
/// number of points beside it.
///
/// And the numbers are not the child's to see as promises. `suggestedAmount`
/// is a suggestion made TO A PARENT at program-creation time — the server
/// says so itself in `rangeNoteAr` («هذه نقاط مقترحة لعمرك، وولي الأمر هو من
/// يحدّد المكافأة النهائية»). Showing «20 نقطة» beside an activity no parent
/// has programmed advertises a reward nobody has agreed to pay.
///
/// So this app takes the route that was, in the backend's own words, «built
/// for exactly this chooser row»: the domain vocabulary and its Arabic
/// labels, and nothing that resembles a startable activity. The honest limit
/// stays intact — programs are parent-authored, and a child who picks an
/// empty domain is told the truth and told what to do about it («كلّم ولي
/// أمرك»), instead of being shown a menu they cannot order from.
/// ---------------------------------------------------------------------------
class ChildCatalogueApi {
  ChildCatalogueApi(this._client);

  final ApiClient _client;

  /// Returns `{child: {...}, domains: [...], totals: {...}}` — an object, so
  /// `get` (which casts to a Map) is the right client method. Unwrapping is
  /// the repository's job.
  Future<Map<String, dynamic>> domains() => _client.get('/self/catalogue/domains');
}
