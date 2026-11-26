import 'package:flutter/material.dart';
import '../services/friday_api_client.dart';

class HomeDashboardScreen extends StatefulWidget {
  final FridayApiClient client;
  final void Function(int tabIndex) onNavigateTab;
  final VoidCallback onOpenVoice;
  final VoidCallback onOpenLocations;
  final VoidCallback onOpenDeviceSettings;
  final VoidCallback onOpenPrivacy;
  final VoidCallback onOpenProfile;

  const HomeDashboardScreen({
    super.key,
    required this.client,
    required this.onNavigateTab,
    required this.onOpenVoice,
    required this.onOpenLocations,
    required this.onOpenDeviceSettings,
    required this.onOpenPrivacy,
    required this.onOpenProfile,
  });

  @override
  State<HomeDashboardScreen> createState() => _HomeDashboardScreenState();
}

class _HomeDashboardScreenState extends State<HomeDashboardScreen> {
  bool _checking = false;

  Future<void> _refresh() async {
    setState(() => _checking = true);
    await widget.client.checkHealth();
    if (mounted) setState(() => _checking = false);
  }

  @override
  Widget build(BuildContext context) {
    final online = widget.client.brainOnline;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          color: online ? const Color(0xFF0E2920) : const Color(0xFF2D1619),
          child: ListTile(
            leading: Icon(online ? Icons.check_circle : Icons.cloud_off, color: online ? Colors.greenAccent : Colors.redAccent),
            title: Text(online ? 'FRIDAY Brain Online' : 'FRIDAY Local Brain Unavailable'),
            subtitle: Text(
              online
                  ? 'Connected to ${widget.client.baseUrl}'
                  : 'Your laptop server is offline. Remote tasks are paused until reconnected.',
            ),
            trailing: IconButton(
              icon: _checking ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.refresh),
              onPressed: _refresh,
            ),
          ),
        ),
        const SizedBox(height: 12),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: 1.5,
          children: [
            _tile(Icons.chat, 'Conversation', () => widget.onNavigateTab(1)),
            _tile(Icons.mic, 'Voice Assistant', widget.onOpenVoice),
            _tile(Icons.monitor_heart, 'Monitoring', () => widget.onNavigateTab(2)),
            _tile(Icons.alarm, 'Reminders', () => widget.onNavigateTab(3)),
            _tile(Icons.notifications, 'Alerts', () => widget.onNavigateTab(4)),
            _tile(Icons.location_on, 'Locations', widget.onOpenLocations),
            _tile(Icons.settings_ethernet, 'Connection', widget.onOpenDeviceSettings),
            _tile(Icons.privacy_tip, 'Privacy', widget.onOpenPrivacy),
          ],
        ),
        const SizedBox(height: 12),
        ListTile(
          leading: const Icon(Icons.person),
          title: const Text('Profile & Logout'),
          trailing: const Icon(Icons.chevron_right),
          onTap: widget.onOpenProfile,
        ),
      ],
    );
  }

  Widget _tile(IconData icon, String title, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Card(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 28, color: Colors.lightBlueAccent),
            const SizedBox(height: 8),
            Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }
}
