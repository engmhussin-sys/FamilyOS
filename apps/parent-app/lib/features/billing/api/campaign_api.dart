import '../../../core/network/api_client.dart';

/// CLOSES A CRITICAL GAP found in a final PM-level review: Sprint B4
/// (Partner Campaigns) built the redemption endpoint and wired it
/// into admin-dashboard (a B2B management tool for
/// companies/schools/banks), but the actual END USER this feature
/// exists for — the parent, on THIS app — had no way to redeem a
/// code at all. This is that missing piece.
class CampaignApi {
  CampaignApi(this._client);

  final ApiClient _client;

  Future<Map<String, dynamic>> redeemCode(String code) {
    return _client.post('/organizations/campaigns/redeem', data: {'code': code});
  }
}
