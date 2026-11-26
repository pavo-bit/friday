import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';

class PairingPage extends ConsumerStatefulWidget {
  const PairingPage({super.key});

  @override
  ConsumerState<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends ConsumerState<PairingPage> {
  late final TextEditingController _urlCtrl;
  final _nameCtrl = TextEditingController(text: 'Android Companion');
  final _codeCtrl = TextEditingController();
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _urlCtrl = TextEditingController(
        text: ref.read(connectionStateProvider).serverUrl);
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    _nameCtrl.dispose();
    _codeCtrl.dispose();
    super.dispose();
  }

  Future<void> _pair() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await ref.read(companionControllerProvider).pairDevice(
            serverUrl: _urlCtrl.text.trim(),
            deviceName: _nameCtrl.text.trim(),
            code: _codeCtrl.text.trim(),
          );
      if (mounted) context.go('/dashboard');
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pair with FRIDAY')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text(
            'Generate a short-lived 6-digit pairing code in the FRIDAY desktop dashboard (Settings & Security), then enter it below.',
            style: TextStyle(color: FridayTheme.textMuted),
          ),
          const SizedBox(height: 18),
          TextField(
            controller: _urlCtrl,
            decoration: const InputDecoration(
                labelText: 'Laptop Server URL (LAN or Tailscale)'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _nameCtrl,
            decoration: const InputDecoration(labelText: 'Device Name'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _codeCtrl,
            keyboardType: TextInputType.number,
            decoration:
                const InputDecoration(labelText: '6-Digit Pairing Code'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: FridayTheme.danger)),
          ],
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _loading ? null : _pair,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 14),
              child: Text(_loading ? 'Pairing…' : 'Pair & Connect'),
            ),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: () {
              ref.read(connectionStateProvider.notifier).setDisconnected(
                    'Standalone mode active. Connect anytime from Connection Settings.',
                  );
              context.go('/dashboard');
            },
            child: const Padding(
              padding: EdgeInsets.symmetric(vertical: 14),
              child: Text('Continue in Standalone Mode'),
            ),
          ),
        ],
      ),
    );
  }
}
