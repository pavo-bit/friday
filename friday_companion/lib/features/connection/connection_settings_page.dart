import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../app/providers.dart';

class ConnectionSettingsPage extends ConsumerStatefulWidget {
  const ConnectionSettingsPage({super.key});

  @override
  ConsumerState<ConnectionSettingsPage> createState() =>
      _ConnectionSettingsPageState();
}

class _ConnectionSettingsPageState
    extends ConsumerState<ConnectionSettingsPage> {
  late final TextEditingController _urlCtrl;

  @override
  void initState() {
    super.initState();
    _urlCtrl = TextEditingController(
        text: ref.read(connectionStateProvider).serverUrl);
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final conn = ref.watch(connectionStateProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Connection Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              title: Text('State: ${conn.label}'),
              subtitle:
                  Text(conn.detail ?? 'No connection check performed yet.'),
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _urlCtrl,
            decoration: const InputDecoration(
              labelText: 'FRIDAY Server URL (LAN or Tailscale)',
              helperText: 'Example: http://192.168.1.50:3141 or Tailscale IP',
            ),
          ),
          const SizedBox(height: 14),
          FilledButton(
            onPressed: () async {
              await ref
                  .read(companionControllerProvider)
                  .checkConnection(urlOverride: _urlCtrl.text.trim());
            },
            child: const Text('Test & Save Connection'),
          ),
          const SizedBox(height: 10),
          OutlinedButton(
            onPressed: () => context.push('/pairing'),
            child: const Text('Open Device Pairing'),
          ),
        ],
      ),
    );
  }
}
