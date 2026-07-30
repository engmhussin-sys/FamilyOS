import 'package:flutter_riverpod/flutter_riverpod.dart';

/// PRODUCTION READINESS REVIEW FIX (API Review — Unauthorized Handling
/// / Session Expiration): `ApiClient` previously cleared the local
/// session on a failed token refresh but had no way to tell the rest of
/// the app "the user is now logged out" — a screen mid-session would
/// just have its next API call fail with an `ApiException`, with
/// nothing redirecting the user to Login. This is a simple counter
/// `ApiClient` increments on forced logout; the root widget listens and
/// navigates to Login when it changes.
final sessionExpiredProvider = StateProvider<int>((ref) => 0);
