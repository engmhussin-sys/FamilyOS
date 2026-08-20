import '../../../core/errors/failure_boundary.dart';
import '../../../core/observability/failure_logger.dart';
import '../api/campaign_api.dart';

/// WHAT A SUCCESSFUL REDEMPTION ACTUALLY IS.
///
/// `CampaignRedemptionService` answers `{campaignType, message}` and the
/// message is BUILT BY THE SERVER with the real numbers in it — "extended by
/// 14 day(s), now ending 2026-09-01", "a 20% discount has been applied". A
/// client cannot reproduce those sentences, so it must not try; it carries
/// them through.
///
/// [message] is nullable rather than defaulted, because the difference
/// between "the server described what it did" and "the server described
/// nothing" is a difference the SCREEN has to resolve with a localised line —
/// not one this layer should paper over with an English literal, which is
/// what `?? 'Success!'` used to do.
class CampaignRedemption {
  const CampaignRedemption({this.campaignType, this.message});

  final String? campaignType;
  final String? message;
}

/// THE BOUNDARY IN FRONT OF A ONE-SHOT CALL.
///
/// A partner code can be redeemed once. That makes the difference between
/// "the server refused this code" and "we never reached the server" load
/// bearing in a way it is not on a list screen: the first means the code is
/// no good, the second means the code is untouched and the parent should try
/// again rather than go hunting for another one. Both arrive here as an
/// [ApiFailure]; `isServerRefusal` is what separates them, and the screen
/// titles them differently on that basis.
class CampaignRepository {
  CampaignRepository(this._api, {FailureLogger? logger})
      : _boundary = FailureBoundary(logger ?? const SentryFailureLogger());

  final CampaignApi _api;
  final FailureBoundary _boundary;

  Future<CampaignRedemption> redeemCode(String code) =>
      _boundary.guard('redeemCode', () async {
        final body = await _api.redeemCode(code);
        return CampaignRedemption(
          campaignType: body['campaignType'] as String?,
          // Read defensively rather than cast: a shape change here would
          // otherwise become a `TypeError` on the ONE path where the call
          // already succeeded, turning an applied benefit into an error
          // screen. `_boundary` would log it honestly, and the parent would
          // still be told their code failed when it did not.
          message: body['message'] is String ? body['message'] as String : null,
        );
      });
}
