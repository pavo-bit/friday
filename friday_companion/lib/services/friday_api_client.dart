import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/friday_models.dart';

class FridayApiException implements Exception {
  final String message;
  final bool isOffline;
  final bool isSessionExpired;
  final int? statusCode;

  FridayApiException(
    this.message, {
    this.isOffline = false,
    this.isSessionExpired = false,
    this.statusCode,
  });

  @override
  String toString() => message;
}

class FridayApiClient {
  String baseUrl;
  String? bearerToken;
  String? deviceId;
  bool brainOnline = false;
  bool sessionExpired = false;
  final http.Client _http;

  FridayApiClient({
    this.baseUrl = 'http://10.0.2.2:3141',
    this.bearerToken,
    this.deviceId,
    http.Client? httpClient,
  }) : _http = httpClient ?? http.Client();

  Map<String, String> _headers() {
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (bearerToken != null && bearerToken!.isNotEmpty) {
      headers['Authorization'] = 'Bearer $bearerToken';
    }
    return headers;
  }

  Future<Map<String, dynamic>> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    try {
      late http.Response res;
      if (method == 'GET') {
        res = await _http
            .get(uri, headers: _headers())
            .timeout(const Duration(seconds: 8));
      } else if (method == 'POST') {
        res = await _http
            .post(uri,
                headers: _headers(),
                body: body != null ? jsonEncode(body) : null)
            .timeout(const Duration(seconds: 15));
      } else if (method == 'PUT') {
        res = await _http
            .put(uri,
                headers: _headers(),
                body: body != null ? jsonEncode(body) : null)
            .timeout(const Duration(seconds: 10));
      } else if (method == 'DELETE') {
        res = await _http
            .delete(uri, headers: _headers())
            .timeout(const Duration(seconds: 8));
      } else {
        throw FridayApiException('Unsupported HTTP method: $method');
      }

      brainOnline = true;
      final decoded = res.body.isNotEmpty
          ? jsonDecode(res.body) as Map<String, dynamic>
          : <String, dynamic>{};
      if (res.statusCode == 401) {
        sessionExpired = true;
        bearerToken = null;
        throw FridayApiException(
          decoded['error']?.toString() ?? 'Session expired or device revoked. Please pair again.',
          isSessionExpired: true,
          statusCode: 401,
        );
      }
      if (res.statusCode >= 400) {
        throw FridayApiException(
          decoded['error']?.toString() ?? 'Request failed (${res.statusCode})',
          statusCode: res.statusCode,
        );
      }
      return decoded;
    } on FridayApiException {
      rethrow;
    } catch (_) {
      brainOnline = false;
      throw FridayApiException(
        "FRIDAY's local brain is currently unavailable. Check that your laptop server is online and reachable.",
        isOffline: true,
      );
    }
  }

  Future<bool> checkHealth() async {
    try {
      await _request('GET', '/friday/health');
      brainOnline = true;
      return true;
    } catch (_) {
      brainOnline = false;
      return false;
    }
  }

  Future<Map<String, dynamic>> pairDevice({
    required String code,
    required String deviceName,
  }) async {
    final res = await _request('POST', '/friday/auth/pair', body: {
      'code': code,
      'name': deviceName,
      'platform': 'android',
    });
    bearerToken = res['token']?.toString();
    final device = res['device'] as Map<String, dynamic>?;
    deviceId = device?['id']?.toString();
    return res;
  }

  Future<String> sendMessage(String text, {String sessionId = 'default'}) async {
    final res = await sendMessageFull(text, sessionId: sessionId);
    return res['output']?.toString() ?? res['error']?.toString() ?? 'Done.';
  }

  Future<Map<String, dynamic>> sendMessageFull(
    String text, {
    String sessionId = 'default',
    String channel = 'android',
  }) async {
    return _request('POST', '/friday/run', body: {
      'text': text,
      'sessionId': sessionId,
      'channel': channel,
    });
  }

  Future<List<Map<String, dynamic>>> getConversationHistory(
      {String sessionId = 'default', int limit = 25}) async {
    final res = await _request(
        'GET', '/friday/conversations?sessionId=$sessionId&limit=$limit');
    return List<Map<String, dynamic>>.from(res['messages'] ?? const []);
  }

  // ---- Phase 18: Cross-Device Identity, Personality, Projects & Learning ----
  Future<Map<String, dynamic>> getIdentityBundle() async {
    return _request('GET', '/friday/identity');
  }

  Future<Map<String, dynamic>> updateIdentity(Map<String, dynamic> patch) async {
    return _request('PUT', '/friday/identity', body: patch);
  }

  Future<Map<String, dynamic>> getPersonality() async {
    return _request('GET', '/friday/personality');
  }

  Future<Map<String, dynamic>> updatePersonality(Map<String, dynamic> patch) async {
    return _request('PUT', '/friday/personality', body: patch);
  }

  Future<Map<String, dynamic>> listProjects() async {
    return _request('GET', '/friday/identity/projects');
  }

  Future<Map<String, dynamic>> switchProject(String projectName) async {
    return _request('POST', '/friday/identity/projects/switch',
        body: {'projectName': projectName});
  }

  Future<List<Map<String, dynamic>>> listLearningRecords({int limit = 20}) async {
    final res = await _request('GET', '/friday/learning/records?limit=$limit');
    return List<Map<String, dynamic>>.from(res['records'] ?? const []);
  }

  Future<List<Map<String, dynamic>>> listProcedures() async {
    final res = await _request('GET', '/friday/learning/procedures');
    return List<Map<String, dynamic>>.from(res['procedures'] ?? const []);
  }

  Future<Map<String, dynamic>> approveProcedure(String procedureId) async {
    return _request('POST', '/friday/learning/procedures/$procedureId/approve',
        body: {'approvedByHuman': true});
  }

  Future<Map<String, dynamic>> recordCorrection(
      {required String subject, required String correction}) async {
    return _request('POST', '/friday/learning/correction',
        body: {'subject': subject, 'correction': correction});
  }

  Future<Map<String, dynamic>> getOllamaStatus() async {
    return _request('GET', '/friday/ollama/status');
  }

  void logout() {
    bearerToken = null;
    deviceId = null;
    sessionExpired = false;
  }

  Future<List<WatcherItem>> listWatchers() async {
    final res = await _request('GET', '/friday/watchers');
    final list = res['watchers'] as List<dynamic>? ?? [];
    return list
        .map((e) => WatcherItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> controlWatcher(String id, String action) async {
    await _request('POST', '/friday/watchers/$id/$action');
  }

  Future<List<ReminderItem>> listReminders() async {
    final res = await _request('GET', '/friday/reminders');
    final list = res['reminders'] as List<dynamic>? ?? [];
    return list
        .map((e) => ReminderItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> createReminder(
      {required String title, String? dueAt, bool isAlarm = false}) async {
    await _request('POST', '/friday/reminders', body: {
      'title': title,
      'dueAt': dueAt,
      'isAlarm': isAlarm,
    });
  }

  Future<List<NotificationItem>> listNotifications() async {
    final res = await _request('GET', '/friday/notifications');
    final list = res['notifications'] as List<dynamic>? ?? [];
    return list
        .map((e) => NotificationItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<List<SavedLocationItem>> listLocations() async {
    final res = await _request('GET', '/friday/locations');
    final list = res['locations'] as List<dynamic>? ?? [];
    return list
        .map((e) => SavedLocationItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> saveLocation({
    required String name,
    required double latitude,
    required double longitude,
    int radiusMeters = 150,
  }) async {
    await _request('POST', '/friday/locations', body: {
      'name': name,
      'latitude': latitude,
      'longitude': longitude,
      'radiusMeters': radiusMeters,
    });
  }

  Future<void> setLocationOptIn(bool optIn) async {
    if (deviceId == null) return;
    await _request('POST', '/friday/auth/devices/$deviceId/location-opt-in',
        body: {'optIn': optIn});
  }

  Future<Map<String, dynamic>> triggerGeofence({
    required String locationName,
    required String eventType,
  }) async {
    if (deviceId == null) {
      throw FridayApiException(
          'Device must be paired before sending geofence events.');
    }
    return _request('POST', '/friday/locations/geofence', body: {
      'deviceId': deviceId,
      'location': locationName,
      'eventType': eventType,
    });
  }
}
