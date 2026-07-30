import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../network/api_client.dart';
import '../storage/secure_session_storage.dart';
import '../../features/authentication/api/auth_api.dart';
import '../../features/authentication/application/auth_controller.dart';
import '../../features/family/api/family_api.dart';
import '../../features/pairing/api/pairing_api.dart';
import '../../features/dashboard/api/dashboard_api.dart';
import '../../features/notifications/api/notifications_api.dart';
import '../../features/settings/api/settings_api.dart';

final secureStorageProvider = Provider<FlutterSecureStorage>((ref) => const FlutterSecureStorage());

final sessionStorageProvider = Provider<SecureSessionStorage>(
  (ref) => SecureSessionStorage(ref.watch(secureStorageProvider)),
);

final apiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(ref.watch(sessionStorageProvider)),
);

final authApiProvider = Provider<AuthApi>((ref) => AuthApi(ref.watch(apiClientProvider)));
final familyApiProvider = Provider<FamilyApi>((ref) => FamilyApi(ref.watch(apiClientProvider)));
final pairingApiProvider = Provider<PairingApi>((ref) => PairingApi(ref.watch(apiClientProvider)));
final dashboardApiProvider = Provider<DashboardApi>((ref) => DashboardApi(ref.watch(apiClientProvider)));
final notificationsApiProvider = Provider<NotificationsApi>((ref) => NotificationsApi(ref.watch(apiClientProvider)));
final settingsApiProvider = Provider<SettingsApi>((ref) => SettingsApi(ref.watch(apiClientProvider)));

final authControllerProvider = StateNotifierProvider<AuthController, AuthState>(
  (ref) => AuthController(ref.watch(authApiProvider), ref.watch(sessionStorageProvider)),
);
