import 'package:flutter/material.dart';
import '../services/friday_api_client.dart';

class DeviceSettingsScreen extends StatefulWidget {
  final FridayApiClient client;
  const DeviceSettingsScreen({super.key, required this.client});

  @override
  State<DeviceSettingsScreen> createState() => _DeviceSettingsScreenState();
}

class _DeviceSettingsScreenState extends State<DeviceSettingsScreen> {
  late final TextEditingController _urlCtrl = TextEditingController(text: widget.client.baseUrl);
  String _status = '';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Device & Connection Settings')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _urlCtrl,
              decoration: const InputDecoration(labelText: 'Server URL', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: () async {
                widget.client.baseUrl = _urlCtrl.text.trim();
                final ok = await widget.client.checkHealth();
                setState(() => _status = ok ? 'Connected successfully.' : 'Server unreachable.');
              },
              child: const Text('Test & Save Connection'),
            ),
            if (_status.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_status)),
          ],
        ),
      ),
    );
  }
}

class PrivacySettingsScreen extends StatefulWidget {
  final FridayApiClient client;
  const PrivacySettingsScreen({super.key, required this.client});

  @override
  State<PrivacySettingsScreen> createState() => _PrivacySettingsScreenState();
}

class _PrivacySettingsScreenState extends State<PrivacySettingsScreen> {
  bool _locationOptIn = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Privacy & Permission Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Location Intelligence is strictly opt-in. Background location is only used to trigger geofence reminders (e.g. when arriving at college). You can stop tracking at any time.',
            style: TextStyle(color: Colors.grey),
          ),
          const SizedBox(height: 12),
          SwitchListTile(
            title: const Text('Enable Geofence Location Tracking'),
            subtitle: const Text('Allows Android companion to report geofence enter/exit events'),
            value: _locationOptIn,
            onChanged: (val) async {
              setState(() => _locationOptIn = val);
              await widget.client.setLocationOptIn(val);
            },
          ),
        ],
      ),
    );
  }
}

class ProfileScreen extends StatelessWidget {
  final FridayApiClient client;
  final VoidCallback onLogout;
  const ProfileScreen({super.key, required this.client, required this.onLogout});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Profile & Logout')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Device ID: ${client.deviceId ?? 'Not paired'}'),
            const SizedBox(height: 8),
            Text('Server: ${client.baseUrl}'),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              style: ElevatedButton.styleFrom(backgroundColor: Colors.redAccent),
              onPressed: () {
                client.bearerToken = null;
                client.deviceId = null;
                onLogout();
                Navigator.of(context).popUntil((route) => route.isFirst);
              },
              icon: const Icon(Icons.logout),
              label: const Text('Unpair & Logout'),
            ),
          ],
        ),
      ),
    );
  }
}
