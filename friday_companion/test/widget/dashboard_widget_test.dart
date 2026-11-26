import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:friday_companion/app/app_theme.dart';
import 'package:friday_companion/app/providers.dart';
import 'package:friday_companion/core/security/secure_storage_service.dart';
import 'package:friday_companion/core/storage/local_database.dart';
import 'package:friday_companion/features/dashboard/dashboard_page.dart';
import 'package:friday_companion/features/device_monitoring/phone_telemetry_service.dart';

void main() {
  testWidgets('DashboardPage renders Standalone mode and phone telemetry',
      (tester) async {
    const fakeTelemetry = PhoneTelemetrySnapshot(
      batteryLevel: 85,
      batteryState: 'discharging',
      deviceModel: 'Pixel Test',
      osVersion: 'Android 15',
      platform: 'android',
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          secureStorageProvider.overrideWithValue(InMemorySecureStorage()),
          localDatabaseProvider.overrideWithValue(InMemoryLocalDatabase()),
          phoneTelemetryProvider.overrideWith((_) async => fakeTelemetry),
        ],
        child: MaterialApp(
          theme: FridayTheme.dark(),
          home: const DashboardPage(),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('FRIDAY Command Center'), findsOneWidget);
    expect(find.text('Disconnected (Standalone)'), findsOneWidget);
    expect(find.textContaining('Pixel Test'), findsOneWidget);
    expect(find.textContaining('85%'), findsOneWidget);
  });
}
