import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:friday_companion/app/providers.dart';
import 'package:friday_companion/core/networking/connection_state.dart';
import 'package:friday_companion/core/security/secure_storage_service.dart';
import 'package:friday_companion/core/storage/local_database.dart';

void main() {
  test('ConnectionStateNotifier transitions through all 5 states accurately',
      () {
    final notifier = ConnectionStateNotifier('http://10.0.2.2:3141');
    expect(notifier.state.status, ConnectionStatus.disconnected);
    expect(notifier.state.isStandalone, true);

    notifier.setConnecting('http://192.168.1.10:3141');
    expect(notifier.state.status, ConnectionStatus.connecting);

    notifier.setConnected(isPaired: true);
    expect(notifier.state.status, ConnectionStatus.connected);
    expect(notifier.state.isConnected, true);

    notifier.setReconnecting();
    expect(notifier.state.status, ConnectionStatus.reconnecting);

    notifier.setAuthRequired();
    expect(notifier.state.status, ConnectionStatus.authRequired);
    expect(notifier.state.isStandalone, true);
  });

  test(
      'CompanionController caches messages honestly when laptop brain is offline',
      () async {
    final storage = InMemorySecureStorage();
    final db = InMemoryLocalDatabase();

    final container = ProviderContainer(
      overrides: [
        secureStorageProvider.overrideWithValue(storage),
        localDatabaseProvider.overrideWithValue(db),
      ],
    );
    addTearDown(container.dispose);

    await container.read(companionControllerProvider).bootstrap();
    expect(
      container.read(connectionStateProvider).status,
      ConnectionStatus.authRequired,
    );

    await container
        .read(companionControllerProvider)
        .sendMessage('Check server');
    final msgs = container.read(cachedMessagesProvider);
    expect(msgs.length, 2);
    expect(msgs.first.role, 'user');
    expect(msgs.last.text, contains('offline'));
  });
}
