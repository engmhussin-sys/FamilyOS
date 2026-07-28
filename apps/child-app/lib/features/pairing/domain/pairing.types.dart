class RegistrationTicket {
  const RegistrationTicket({required this.token, required this.expiresInSeconds});

  final String token;
  final int expiresInSeconds;
}

class DeviceRegistrationResult {
  const DeviceRegistrationResult({
    required this.deviceId,
    required this.accessToken,
    required this.refreshToken,
  });

  final String deviceId;
  final String accessToken;
  final String refreshToken;
}
