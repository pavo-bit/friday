import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:friday_companion/models/friday_models.dart';
import 'package:friday_companion/services/friday_api_client.dart';
import 'package:friday_companion/services/location_service.dart';

void main() {
  test('Pairing stores bearer token and deviceId', () async {
    final mockHttp = MockClient((req) async {
      expect(req.url.path, '/friday/auth/pair');
      return http.Response(
        jsonEncode({
          'token': 'frd_test_token_123',
          'device': {'id': 'dev-1', 'name': 'Test Phone'},
        }),
        201,
      );
    });

    final client =
        FridayApiClient(baseUrl: 'http://127.0.0.1:3141', httpClient: mockHttp);
    await client.pairDevice(code: '123456', deviceName: 'Test Phone');
    expect(client.bearerToken, 'frd_test_token_123');
    expect(client.deviceId, 'dev-1');
  });

  test('Offline server marks brainOnline false and throws clear message',
      () async {
    final mockHttp = MockClient((_) async {
      throw Exception('SocketException: Connection refused');
    });

    final client =
        FridayApiClient(baseUrl: 'http://127.0.0.1:3141', httpClient: mockHttp);
    expect(
      () => client.sendMessage('hello'),
      throwsA(
        predicate<FridayApiException>(
          (e) => e.isOffline && e.message.contains('unavailable'),
        ),
      ),
    );
    expect(client.brainOnline, false);
  });

  test('GeofenceEvaluator detects inside vs outside coordinates accurately',
      () {
    final college = SavedLocationItem(
      id: 'loc-1',
      name: 'college',
      latitude: 12.9716,
      longitude: 77.5946,
      radiusMeters: 150,
    );

    expect(GeofenceEvaluator.isInsideGeofence(12.9716, 77.5946, college), true);
    expect(
        GeofenceEvaluator.isInsideGeofence(13.0500, 77.5946, college), false);
  });
}
