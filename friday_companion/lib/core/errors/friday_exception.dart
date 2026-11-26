sealed class FridayException implements Exception {
  final String message;
  final int? statusCode;

  const FridayException(this.message, {this.statusCode});

  @override
  String toString() => message;
}

class OfflineBrainException extends FridayException {
  const OfflineBrainException([
    super.message =
        "FRIDAY's local brain is unavailable. Standalone phone features remain active.",
  ]);
}

class AuthenticationException extends FridayException {
  const AuthenticationException([
    super.message =
        'Device authentication required. Please pair or re-authenticate.',
  ]) : super(statusCode: 401);
}

class NetworkException extends FridayException {
  const NetworkException(super.message, {super.statusCode});
}

class ValidationException extends FridayException {
  const ValidationException(super.message);
}
