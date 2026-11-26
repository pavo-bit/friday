import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';

class AppSettingsPage extends ConsumerWidget {
  const AppSettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cfg = ref.watch(appConfigProvider);
    final conn = ref.watch(connectionStateProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Application Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              title: const Text('Environment'),
              subtitle: Text(
                  '${cfg.environment} · Timeout ${cfg.requestTimeout.inSeconds}s'),
            ),
          ),
          Card(
            child: ListTile(
              title: const Text('Pairing Status'),
              subtitle: Text(conn.isPaired
                  ? 'Paired with ${conn.serverUrl}'
                  : 'Not paired'),
            ),
          ),
          const SizedBox(height: 20),
          FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: FridayTheme.danger),
            onPressed: () async {
              await ref.read(companionControllerProvider).unpairAndLogout();
              if (context.mounted) context.go('/pairing');
            },
            icon: const Icon(Icons.logout),
            label: const Text('Unpair & Clear Credentials'),
          ),
        ],
      ),
    );
  }
}
