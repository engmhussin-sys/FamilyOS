import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../contracts/cached_policy.dart';

const _policyStorageKey = 'cre_cached_policy';

/// Sprint 4 (Child Runtime Engine) §5's Local Policy Engine — storage
/// half. Reuses `flutter_secure_storage` (already a Step 1 dependency)
/// rather than adding a new persistence package; the policy JSON is
/// small (a handful of fields), so a single secure-storage key is
/// sufficient — no need for a real embedded database for this MVP scope.
class PolicyCacheService {
  PolicyCacheService(this._storage);

  final FlutterSecureStorage _storage;

  Future<void> cache(CachedPolicy policy) async {
    await _storage.write(key: _policyStorageKey, value: jsonEncode(policy.toJson()));
  }

  /// Never returns null — falls back to [defaultOfflinePolicy] if
  /// nothing has synced yet, per the reviewer's "must still remain
  /// protected" requirement. A malformed/corrupted cache entry is
  /// treated the same as "nothing cached" (falls back), not a crash.
  Future<CachedPolicy> getCurrentPolicy() async {
    final raw = await _storage.read(key: _policyStorageKey);
    if (raw == null) return defaultOfflinePolicy;
    try {
      return CachedPolicy.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return defaultOfflinePolicy;
    }
  }
}
