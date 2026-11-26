import 'package:flutter/material.dart';
import '../services/friday_api_client.dart';

class PairingScreen extends StatefulWidget {
  final FridayApiClient client;
  final VoidCallback onPaired;

  const PairingScreen({super.key, required this.client, required this.onPaired});

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final _urlCtrl = TextEditingController();
  final _codeCtrl = TextEditingController();
  final _nameCtrl = TextEditingController(text: 'My Android');
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _urlCtrl.text = widget.client.baseUrl;
  }

  Future<void> _pair() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      widget.client.baseUrl = _urlCtrl.text.trim();
      await widget.client.pairDevice(
        code: _codeCtrl.text.trim(),
        deviceName: _nameCtrl.text.trim(),
      );
      if (mounted) widget.onPaired();
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
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: ListView(
          children: [
            const Text(
              'Enter the 6-digit pairing code generated from your FRIDAY web dashboard (Settings → Security).',
              style: TextStyle(color: Colors.grey),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _urlCtrl,
              decoration: const InputDecoration(labelText: 'FRIDAY Server URL', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _nameCtrl,
              decoration: const InputDecoration(labelText: 'Device Name', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _codeCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: '6-Digit Pairing Code', border: OutlineInputBorder()),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.redAccent)),
            ],
            const SizedBox(height: 18),
            ElevatedButton(
              onPressed: _loading ? null : _pair,
              child: Text(_loading ? 'Pairing…' : 'Pair Device'),
            ),
          ],
        ),
      ),
    );
  }
}
