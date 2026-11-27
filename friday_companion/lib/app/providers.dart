import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/errors/friday_exception.dart';
import '../core/networking/connection_state.dart';
import '../core/networking/friday_dio_client.dart';
import '../core/networking/friday_ws_client.dart';
import '../core/security/secure_storage_service.dart';
import '../core/storage/local_database.dart';
import '../features/device_monitoring/device_control_service.dart';
import '../features/device_monitoring/phone_telemetry_service.dart';
import '../services/companion_api_service.dart';
import 'app_config.dart';

final appConfigProvider = Provider<AppConfig>((ref) {
  return AppConfig.fromEnvironment();
});

final secureStorageProvider = Provider<SecureStorageService>((ref) {
  return KeystoreSecureStorage();
});

final localDatabaseProvider = Provider<LocalDatabase>((ref) {
  return SqliteLocalDatabase();
});

final dioClientProvider = Provider<FridayDioClient>((ref) {
  final cfg = ref.watch(appConfigProvider);
  return FridayDioClient(
      baseUrl: cfg.defaultBaseUrl, timeout: cfg.requestTimeout);
});

final wsClientProvider = Provider<FridayWsClient>((ref) {
  final ws = FridayWsClient();
  ref.onDispose(ws.disconnect);
  return ws;
});

final companionApiProvider = Provider<CompanionApiService>((ref) {
  return CompanionApiService(ref.watch(dioClientProvider));
});

final screenShareProvider =
    StateNotifierProvider<ScreenShareController, ScreenShareState>((ref) {
  return ScreenShareController();
});

final permissionPrivacyProvider =
    StateNotifierProvider<PermissionPrivacyNotifier, PermissionPrivacyState>(
        (ref) {
  return PermissionPrivacyNotifier();
});

final connectionStateProvider =
    StateNotifierProvider<ConnectionStateNotifier, ConnectionSnapshot>((ref) {
  final cfg = ref.watch(appConfigProvider);
  return ConnectionStateNotifier(cfg.defaultBaseUrl);
});

final phoneTelemetryServiceProvider = Provider<PhoneTelemetryService>((ref) {
  return PhoneTelemetryService();
});

final phoneTelemetryProvider =
    FutureProvider<PhoneTelemetrySnapshot>((ref) async {
  return ref.watch(phoneTelemetryServiceProvider).collect();
});

final cachedMessagesProvider =
    StateProvider<List<CachedConversationItem>>((ref) => const []);
final activityHistoryProvider =
    StateProvider<List<LocalActivityRecord>>((ref) => const []);
final onboardingCompleteProvider = StateProvider<bool>((ref) => false);

final companionControllerProvider = Provider<CompanionController>((ref) {
  return CompanionController(ref);
});

class CompanionController {
  final Ref _ref;
  CompanionController(this._ref);

  Future<void> bootstrap() async {
    final storage = _ref.read(secureStorageProvider);
    final db = _ref.read(localDatabaseProvider);
    final dio = _ref.read(dioClientProvider);
    final conn = _ref.read(connectionStateProvider.notifier);

    await db.initialize();
    _ref.read(cachedMessagesProvider.notifier).state = await db.getMessages();
    _ref.read(activityHistoryProvider.notifier).state =
        await db.getActivities();

    final onboarding = await storage.read(SecureKeys.onboardingDone);
    _ref.read(onboardingCompleteProvider.notifier).state = onboarding == 'true';

    final savedUrl = await storage.read(SecureKeys.serverUrl);
    final token = await storage.read(SecureKeys.bearerToken);
    final url = (savedUrl != null && savedUrl.isNotEmpty)
        ? savedUrl
        : _ref.read(appConfigProvider).defaultBaseUrl;

    dio.updateConfig(baseUrl: url, bearerToken: token);

    if (token == null || token.isEmpty) {
      conn.setAuthRequired(detail: 'Pair this phone to connect to FRIDAY.');
      return;
    }

    await checkConnection(urlOverride: url);
  }

  Future<void> completeOnboarding() async {
    await _ref
        .read(secureStorageProvider)
        .write(SecureKeys.onboardingDone, 'true');
    _ref.read(onboardingCompleteProvider.notifier).state = true;
  }

  Future<bool> checkConnection({String? urlOverride}) async {
    final storage = _ref.read(secureStorageProvider);
    final dio = _ref.read(dioClientProvider);
    final conn = _ref.read(connectionStateProvider.notifier);
    final targetUrl =
        urlOverride ?? _ref.read(connectionStateProvider).serverUrl;
    final token = await storage.read(SecureKeys.bearerToken);

    conn.setConnecting(targetUrl);
    dio.updateConfig(baseUrl: targetUrl, bearerToken: token);
    await storage.write(SecureKeys.serverUrl, targetUrl);

    try {
      await dio.get('/friday/health');
      final hasToken = token != null && token.isNotEmpty;
      conn.setConnected(
        isPaired: hasToken,
        detail: hasToken
            ? 'Connected & authenticated with FRIDAY'
            : 'Reachable, but device pairing is required',
      );
      await _recordActivity(
          'connection_check', 'Connected to $targetUrl', 'connected');
      return true;
    } on AuthenticationException catch (e) {
      conn.setAuthRequired(detail: e.message);
      await _recordActivity('connection_check', e.message, 'standalone');
      return false;
    } on FridayException catch (e) {
      conn.setDisconnected(e.message);
      await _recordActivity('connection_check', e.message, 'standalone');
      return false;
    }
  }

  Future<void> pairDevice({
    required String serverUrl,
    required String deviceName,
    required String code,
  }) async {
    final storage = _ref.read(secureStorageProvider);
    final dio = _ref.read(dioClientProvider);
    final conn = _ref.read(connectionStateProvider.notifier);

    conn.setConnecting(serverUrl);
    dio.updateConfig(baseUrl: serverUrl);

    try {
      final res = await dio.post('/friday/auth/pair', data: {
        'code': code.trim(),
        'name': deviceName.trim(),
        'platform': 'android',
      });
      final token = res['token']?.toString();
      final device = res['device'] as Map<String, dynamic>?;
      final deviceId = device?['id']?.toString() ?? '';

      if (token == null || token.isEmpty) {
        throw const ValidationException(
            'Server did not return a device token.');
      }

      await storage.write(SecureKeys.serverUrl, serverUrl);
      await storage.write(SecureKeys.bearerToken, token);
      await storage.write(SecureKeys.deviceId, deviceId);

      dio.updateConfig(baseUrl: serverUrl, bearerToken: token);
      conn.setConnected(isPaired: true, detail: 'Paired as $deviceName');
      await _recordActivity(
          'device_paired', 'Paired with $serverUrl', 'connected');
    } on FridayException catch (e) {
      if (e is OfflineBrainException) {
        conn.setDisconnected(e.message);
      } else {
        conn.setAuthRequired(detail: e.message);
      }
      rethrow;
    }
  }

  Future<void> sendMessage(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;

    final db = _ref.read(localDatabaseProvider);
    final dio = _ref.read(dioClientProvider);
    final connState = _ref.read(connectionStateProvider);
    final conn = _ref.read(connectionStateProvider.notifier);

    final userMsg = CachedConversationItem(
      id: 'u_${DateTime.now().microsecondsSinceEpoch}',
      role: 'user',
      text: trimmed,
      timestamp: DateTime.now().toIso8601String(),
    );
    await db.saveMessage(userMsg);
    _ref.read(cachedMessagesProvider.notifier).state = await db.getMessages();

    if (!connState.isConnected) {
      const offlineText =
          "FRIDAY's local brain is currently offline. Your message was cached locally; reconnect to your laptop to process AI requests.";
      final sysMsg = CachedConversationItem(
        id: 's_${DateTime.now().microsecondsSinceEpoch}',
        role: 'assistant',
        text: offlineText,
        timestamp: DateTime.now().toIso8601String(),
      );
      await db.saveMessage(sysMsg);
      _ref.read(cachedMessagesProvider.notifier).state = await db.getMessages();
      await _recordActivity('assistant_offline', trimmed, 'standalone');
      return;
    }

    try {
      final res = await dio.post('/friday/run', data: {'text': trimmed});
      final reply =
          res['output']?.toString() ?? res['error']?.toString() ?? 'Done.';
      final botMsg = CachedConversationItem(
        id: 'a_${DateTime.now().microsecondsSinceEpoch}',
        role: 'assistant',
        text: reply,
        timestamp: DateTime.now().toIso8601String(),
      );
      await db.saveMessage(botMsg);
      _ref.read(cachedMessagesProvider.notifier).state = await db.getMessages();
      await _recordActivity('assistant_prompt', trimmed, 'connected');
    } on AuthenticationException catch (e) {
      conn.setAuthRequired(detail: e.message);
      rethrow;
    } on OfflineBrainException catch (e) {
      conn.setDisconnected(e.message);
      final errMsg = CachedConversationItem(
        id: 'e_${DateTime.now().microsecondsSinceEpoch}',
        role: 'assistant',
        text: e.message,
        timestamp: DateTime.now().toIso8601String(),
      );
      await db.saveMessage(errMsg);
      _ref.read(cachedMessagesProvider.notifier).state = await db.getMessages();
    }
  }

  Future<void> unpairAndLogout() async {
    final storage = _ref.read(secureStorageProvider);
    final dio = _ref.read(dioClientProvider);
    final ws = _ref.read(wsClientProvider);
    final db = _ref.read(localDatabaseProvider);
    ws.disconnect();
    await storage.delete(SecureKeys.bearerToken);
    await storage.delete(SecureKeys.deviceId);
    dio.clearToken();
    await db.clearAll();
    _ref.read(cachedMessagesProvider.notifier).state = const [];
    _ref
        .read(connectionStateProvider.notifier)
        .setAuthRequired(detail: 'Device unpaired.');
    await _recordActivity(
        'device_unpaired', 'Cleared local credentials and cached data', 'standalone');
  }

  Future<void> _recordActivity(
      String action, String detail, String mode) async {
    final db = _ref.read(localDatabaseProvider);
    await db.logActivity(
      LocalActivityRecord(
        id: 'act_${DateTime.now().microsecondsSinceEpoch}',
        action: action,
        detail: detail,
        mode: mode,
        createdAt: DateTime.now().toIso8601String(),
      ),
    );
    _ref.read(activityHistoryProvider.notifier).state =
        await db.getActivities();
  }
}
