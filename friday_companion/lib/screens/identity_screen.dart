import 'package:flutter/material.dart';
import '../services/friday_api_client.dart';

class IdentityScreen extends StatefulWidget {
  final FridayApiClient client;
  const IdentityScreen({super.key, required this.client});

  @override
  State<IdentityScreen> createState() => _IdentityScreenState();
}

class _IdentityScreenState extends State<IdentityScreen> {
  final _addressCtrl = TextEditingController(text: 'Boss');
  String _personality = 'ADAPTIVE';
  String _style = 'NATURAL';
  String _detail = 'ADAPTIVE';
  bool _loading = true;
  String? _status;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final idBundle = await widget.client.getIdentityBundle();
      final persData = await widget.client.getPersonality();
      final prof = idBundle['profile'] as Map<String, dynamic>?;
      final dig = persData['digitalIdentity'] as Map<String, dynamic>?;
      if (mounted) {
        setState(() {
          _addressCtrl.text = prof?['preferredAddress']?.toString() ?? 'Boss';
          _personality = dig?['defaultPersonality']?.toString() ?? 'ADAPTIVE';
          _style = dig?['communicationStyle']?.toString() ?? 'NATURAL';
          _detail = dig?['answerDetail']?.toString() ?? 'ADAPTIVE';
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _status = e.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _save() async {
    try {
      await widget.client.updateIdentity({'preferredAddress': _addressCtrl.text.trim()});
      await widget.client.updatePersonality({
        'defaultPersonality': _personality,
        'communicationStyle': _style,
        'answerDetail': _detail,
      });
      if (mounted) setState(() => _status = 'Synchronized with FRIDAY core.');
    } catch (e) {
      if (mounted) setState(() => _status = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Personal Identity & Personality')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                TextField(
                  controller: _addressCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Preferred Address',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _personality,
                  decoration: const InputDecoration(
                    labelText: 'Default Personality',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(value: 'ADAPTIVE', child: Text('Adaptive (Automatic)')),
                    DropdownMenuItem(value: 'TEACHER', child: Text('Teacher')),
                    DropdownMenuItem(value: 'FRIEND', child: Text('Friend')),
                    DropdownMenuItem(value: 'COMPANION', child: Text('Companion')),
                    DropdownMenuItem(value: 'TECHNICAL_EXPERT', child: Text('Technical Expert')),
                    DropdownMenuItem(value: 'PROFESSIONAL_ASSISTANT', child: Text('Professional Assistant')),
                  ],
                  onChanged: (v) => setState(() => _personality = v ?? 'ADAPTIVE'),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _style,
                  decoration: const InputDecoration(
                    labelText: 'Communication Style',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(value: 'NATURAL', child: Text('Natural')),
                    DropdownMenuItem(value: 'WARM', child: Text('Warm')),
                    DropdownMenuItem(value: 'DIRECT', child: Text('Direct')),
                    DropdownMenuItem(value: 'FORMAL', child: Text('Formal')),
                  ],
                  onChanged: (v) => setState(() => _style = v ?? 'NATURAL'),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _detail,
                  decoration: const InputDecoration(
                    labelText: 'Response Detail',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(value: 'ADAPTIVE', child: Text('Adaptive')),
                    DropdownMenuItem(value: 'CONCISE', child: Text('Concise')),
                    DropdownMenuItem(value: 'BALANCED', child: Text('Balanced')),
                    DropdownMenuItem(value: 'DETAILED', child: Text('Detailed')),
                  ],
                  onChanged: (v) => setState(() => _detail = v ?? 'ADAPTIVE'),
                ),
                const SizedBox(height: 16),
                ElevatedButton(onPressed: _save, child: const Text('Sync Identity')),
                if (_status != null)
                  Padding(padding: const EdgeInsets.only(top: 12), child: Text(_status!)),
              ],
            ),
    );
  }
}
