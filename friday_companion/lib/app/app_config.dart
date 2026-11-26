class AppConfig {
  final String defaultBaseUrl;
  final String environment;
  final Duration requestTimeout;

  const AppConfig({
    required this.defaultBaseUrl,
    required this.environment,
    required this.requestTimeout,
  });

  factory AppConfig.fromEnvironment() {
    const baseUrl = String.fromEnvironment(
      'FRIDAY_BASE_URL',
      defaultValue: 'http://10.0.2.2:3141',
    );
    const env = String.fromEnvironment(
      'FRIDAY_ENV',
      defaultValue: 'development',
    );
    const timeoutMs = int.fromEnvironment(
      'FRIDAY_REQUEST_TIMEOUT_MS',
      defaultValue: 10000,
    );

    return const AppConfig(
      defaultBaseUrl: baseUrl,
      environment: env,
      requestTimeout: Duration(milliseconds: timeoutMs),
    );
  }
}
