import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/storage/secure_session_storage.dart';
import '../api/auth_api.dart';

enum AuthStatus { unknown, authenticated, unauthenticated }

class AuthState {
  const AuthState({this.status = AuthStatus.unknown, this.errorMessage});

  final AuthStatus status;
  final String? errorMessage;

  AuthState copyWith({AuthStatus? status, String? errorMessage}) =>
      AuthState(status: status ?? this.status, errorMessage: errorMessage);
}

/// The Splash Screen's own logic lives here, not in the widget:
/// `checkSession()` decides Logged-in -> Dashboard vs. New user -> Login.
class AuthController extends StateNotifier<AuthState> {
  AuthController(this._authApi, this._sessionStorage) : super(const AuthState());

  final AuthApi _authApi;
  final SecureSessionStorage _sessionStorage;

  Future<void> checkSession() async {
    final hasSession = await _sessionStorage.hasSession();
    state = AuthState(status: hasSession ? AuthStatus.authenticated : AuthStatus.unauthenticated);
  }

  Future<bool> login(String email, String password) async {
    try {
      final result = await _authApi.login(email: email, password: password);
      await _sessionStorage.saveTokens(
        accessToken: result['accessToken'] as String,
        refreshToken: result['refreshToken'] as String,
      );
      state = const AuthState(status: AuthStatus.authenticated);
      return true;
    } catch (e) {
      state = AuthState(status: AuthStatus.unauthenticated, errorMessage: e.toString());
      return false;
    }
  }

  Future<bool> register(String fullName, String email, String password, {required bool acceptedTerms}) async {
    try {
      final result = await _authApi.register(fullName: fullName, email: email, password: password, acceptedTerms: acceptedTerms);
      await _sessionStorage.saveTokens(
        accessToken: result['accessToken'] as String,
        refreshToken: result['refreshToken'] as String,
      );
      state = const AuthState(status: AuthStatus.authenticated);
      return true;
    } catch (e) {
      state = AuthState(status: AuthStatus.unauthenticated, errorMessage: e.toString());
      return false;
    }
  }

  Future<void> logout() async {
    final refreshToken = await _sessionStorage.getRefreshToken();
    if (refreshToken != null) {
      try {
        await _authApi.logout(refreshToken);
      } catch (_) {
        // Best-effort server-side revoke.
      }
    }
    await _sessionStorage.clear();
    state = const AuthState(status: AuthStatus.unauthenticated);
  }
}
