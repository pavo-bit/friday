import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:friday_companion/app/providers.dart';
import 'package:friday_companion/core/networking/friday_dio_client.dart';
import 'package:friday_companion/core/networking/friday_ws_client.dart';
import 'package:friday_companion/core/security/secure_storage_service.dart';
import 'package:friday_companion/core/storage/local_database.dart';
import 'package:friday_companion/features/approvals/approvals_page.dart';
import 'package:friday_companion/features/device_monitoring/device_control_service.dart';
import 'package:friday_companion/features/device_monitoring/screen_share_page.dart';
import 'package:friday_companion/features/finance/finance_page.dart';
import 'package:friday_companion/features/presentations/presentations_page.dart';
import 'package:friday_companion/features/trading/trading_page.dart';
import 'package:friday_companion/services/companion_api_service.dart';

class _StubAdapter implements HttpClientAdapter {
  final List<RequestOptions> requests = [];
  final Map<String, dynamic> Function(RequestOptions options) handler;

  _StubAdapter(this.handler);

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final body = jsonEncode(handler(options));
    return ResponseBody.fromString(
      body,
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  test('FridayWsClient builds clean WS URI without query-string tokens', () {
    final ws = FridayWsClient();
    final uri = ws.buildWsUri('http://100.64.0.10:3141');
    expect(uri.scheme, 'ws');
    expect(uri.host, '100.64.0.10');
    expect(uri.port, 3141);
    expect(uri.path, '/friday/ws');
    expect(uri.hasQuery, isFalse);

    final wssUri = ws.buildWsUri('https://friday.tailnet.ts.net');
    expect(wssUri.scheme, 'wss');
    expect(wssUri.hasQuery, isFalse);
  });

  test('CompanionApiService sends Bearer token and hits Phase 3-7 endpoints', () async {
    final adapter = _StubAdapter((req) {
      if (req.path == '/friday/approvals') {
        return {'approvals': []};
      }
      if (req.path == '/friday/presentations') {
        return {'presentations': []};
      }
      if (req.path == '/friday/finance/overview') {
        return {'netWorthFormatted': '1000.00', 'currency': 'INR'};
      }
      if (req.path == '/friday/trading/overview') {
        return {'session': null, 'riskConfig': null, 'watchlist': [], 'journal': []};
      }
      return {'ok': true};
    });

    final dio = Dio(BaseOptions(baseUrl: 'http://127.0.0.1:3141'));
    dio.httpClientAdapter = adapter;
    final client = FridayDioClient(baseUrl: 'http://127.0.0.1:3141', dio: dio);
    client.updateConfig(bearerToken: 'frd_test_token_123');
    final api = CompanionApiService(client);

    await api.listPendingApprovals();
    await api.approveAction('app-1', resolution: 'ok');
    await api.listPresentations();
    final fin = await api.getFinanceOverview();
    expect(fin['netWorthFormatted'], '1000.00');
    await api.confirmTradingCapital(
      totalEquity: '100000',
      availableCash: '50000',
      allocatedCapital: '25000',
      confirmedByUser: true,
    );

    expect(
      adapter.requests.every((r) => r.headers['Authorization'] == 'Bearer frd_test_token_123'),
      isTrue,
    );
    expect(
      adapter.requests.any((r) => r.path == '/friday/approvals/app-1/approve'),
      isTrue,
    );
    expect(
      adapter.requests.any((r) => r.path == '/friday/trading/capital/confirm'),
      isTrue,
    );
  });

  test('Logout clears bearer token, device ID, and cached snapshots', () async {
    final storage = InMemorySecureStorage();
    final db = InMemoryLocalDatabase();
    await storage.write(SecureKeys.bearerToken, 'frd_secret');
    await storage.write(SecureKeys.deviceId, 'dev-1');
    await db.saveCacheSnapshot('finance_overview', '{"netWorthFormatted":"500.00"}', '2026-11-27');

    final container = ProviderContainer(overrides: [
      secureStorageProvider.overrideWithValue(storage),
      localDatabaseProvider.overrideWithValue(db),
    ]);
    addTearDown(container.dispose);

    await container.read(companionControllerProvider).unpairAndLogout();
    expect(await storage.read(SecureKeys.bearerToken), isNull);
    expect(await storage.read(SecureKeys.deviceId), isNull);
    expect(await db.getCacheSnapshot('finance_overview'), isNull);
  });

  test('ScreenShareController requires manual start and consent; privacy defaults are restrictive', () async {
    final ctrl = ScreenShareController();
    expect(ctrl.state.isActive, isFalse);

    final denied = await ctrl.startSession(
      manualUserInitiated: false,
      androidConsentGranted: true,
    );
    expect(denied, isFalse);
    expect(ctrl.state.isActive, isFalse);

    final started = await ctrl.startSession(
      manualUserInitiated: true,
      androidConsentGranted: true,
    );
    expect(started, isTrue);
    expect(ctrl.state.isActive, isTrue);

    await ctrl.stopSession();
    expect(ctrl.state.isActive, isFalse);
    expect(ctrl.state.status, ScreenShareStatus.stopped);

    final priv = PermissionPrivacyNotifier();
    expect(priv.state.notificationAccessEnabled, isFalse);
    expect(priv.state.notificationContentOptIn, isFalse);
    expect(priv.state.microphoneEnabled, isFalse);
    // Content opt-in cannot be enabled while notification access is disabled
    priv.setNotificationContentOptIn(true);
    expect(priv.state.notificationContentOptIn, isFalse);

    expect(
      validateConfirmedDeviceAction(actionName: 'launch_app', confirmedByUser: false),
      isFalse,
    );
    expect(
      validateConfirmedDeviceAction(actionName: 'launch_app', confirmedByUser: true),
      isTrue,
    );
    expect(
      validateConfirmedDeviceAction(actionName: 'rm_rf_shell', confirmedByUser: true),
      isFalse,
    );
  });

  testWidgets('ApprovalsPage, PresentationsPage, FinancePage, TradingPage, and ScreenSharePage render cleanly',
      (tester) async {
    final adapter = _StubAdapter((req) {
      if (req.path.startsWith('/friday/approvals')) {
        return {
          'approvals': [
            {
              'approvalId': 'app-99',
              'capabilityId': 'core.terminal.exec',
              'riskLevel': 'high',
              'summary': 'Run diagnostic check',
              'permissionScope': 'system:exec',
              'deviceId': 'dev-1',
              'expiresAt': '2026-11-27T18:00:00Z',
            }
          ]
        };
      }
      if (req.path.startsWith('/friday/presentations')) {
        return {
          'presentations': [
            {
              'presentationId': 'pres-1',
              'presentationType': 'summary',
              'title': 'System Check',
              'summary': 'All subsystems healthy',
              'verificationStatus': 'VERIFIED',
              'provenance': [
                {'sourceName': 'HealthCheck', 'freshnessLabel': 'live (1s old)'}
              ]
            }
          ]
        };
      }
      if (req.path.startsWith('/friday/finance/overview')) {
        return {
          'currency': 'INR',
          'netWorthFormatted': '125000.00',
          'cashFlow': {
            'period': '2026-11',
            'totalIncomeFormatted': '100000.00',
            'totalExpenseFormatted': '25000.00',
            'netCashFlowFormatted': '75000.00',
          },
          'portfolio': {'holdingsCount': 2, 'concentrationRisk': 'low', 'totalValueFormatted': '50000.00'},
          'budgets': [],
          'goals': [],
          'debts': [],
        };
      }
      if (req.path.startsWith('/friday/trading/overview')) {
        return {'session': null, 'riskConfig': null, 'watchlist': [], 'journal': []};
      }
      return {};
    });

    final dio = Dio(BaseOptions(baseUrl: 'http://127.0.0.1:3141'));
    dio.httpClientAdapter = adapter;
    final client = FridayDioClient(baseUrl: 'http://127.0.0.1:3141', dio: dio);
    final db = InMemoryLocalDatabase();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioClientProvider.overrideWithValue(client),
          localDatabaseProvider.overrideWithValue(db),
        ],
        child: const MaterialApp(home: ApprovalsPage()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('core.terminal.exec'), findsOneWidget);
    expect(find.text('Approve'), findsOneWidget);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioClientProvider.overrideWithValue(client),
          localDatabaseProvider.overrideWithValue(db),
        ],
        child: const MaterialApp(home: PresentationsPage()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('[SUMMARY] System Check'), findsOneWidget);
    expect(find.text('VERIFIED'), findsOneWidget);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioClientProvider.overrideWithValue(client),
          localDatabaseProvider.overrideWithValue(db),
        ],
        child: const MaterialApp(home: FinancePage()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('INR 125000.00'), findsOneWidget);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioClientProvider.overrideWithValue(client),
          localDatabaseProvider.overrideWithValue(db),
        ],
        child: const MaterialApp(home: TradingPage()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Market Data Feed: NO LIVE FEED'), findsOneWidget);

    await tester.pumpWidget(
      ProviderScope(
        key: UniqueKey(),
        child: const MaterialApp(home: ScreenSharePage()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Explicit Screen Sharing (MediaProjection)'), findsOneWidget);
    expect(find.text('Start Session'), findsOneWidget);
  });
}
