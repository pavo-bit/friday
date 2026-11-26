import 'package:flutter/material.dart';
import 'services/friday_api_client.dart';
import 'screens/splash_screen.dart';
import 'screens/pairing_screen.dart';
import 'screens/home_dashboard_screen.dart';
import 'screens/conversation_screen.dart';
import 'screens/voice_assistant_screen.dart';
import 'screens/monitoring_screen.dart';
import 'screens/alerts_screen.dart';
import 'screens/reminders_screen.dart';
import 'screens/locations_screen.dart';
import 'screens/settings_screens.dart';

void main() {
  runApp(const FridayCompanionApp());
}

class FridayCompanionApp extends StatefulWidget {
  const FridayCompanionApp({super.key});

  @override
  State<FridayCompanionApp> createState() => _FridayCompanionAppState();
}

class _FridayCompanionAppState extends State<FridayCompanionApp> {
  final FridayApiClient _client = FridayApiClient();
  String _stage = 'splash'; // 'splash' | 'pairing' | 'main'
  int _tabIndex = 0;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FRIDAY Companion',
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF070B14),
        colorScheme: const ColorScheme.dark(primary: Color(0xFF3B82F6)),
      ),
      home: _buildRoot(context),
    );
  }

  Widget _buildRoot(BuildContext context) {
    if (_stage == 'splash') {
      return SplashScreen(
        client: _client,
        onReadyPaired: () => setState(() => _stage = 'main'),
        onNeedsPairing: () => setState(() => _stage = 'pairing'),
      );
    }
    if (_stage == 'pairing') {
      return PairingScreen(
        client: _client,
        onPaired: () => setState(() => _stage = 'main'),
      );
    }

    return Builder(
      builder: (ctx) {
        final screens = [
          HomeDashboardScreen(
            client: _client,
            onNavigateTab: (i) => setState(() => _tabIndex = i),
            onOpenVoice: () => Navigator.of(ctx).push(MaterialPageRoute(builder: (_) => VoiceAssistantScreen(client: _client))),
            onOpenLocations: () => Navigator.of(ctx).push(MaterialPageRoute(builder: (_) => LocationsScreen(client: _client))),
            onOpenDeviceSettings: () => Navigator.of(ctx).push(MaterialPageRoute(builder: (_) => DeviceSettingsScreen(client: _client))),
            onOpenPrivacy: () => Navigator.of(ctx).push(MaterialPageRoute(builder: (_) => PrivacySettingsScreen(client: _client))),
            onOpenProfile: () => Navigator.of(ctx).push(
              MaterialPageRoute(
                builder: (_) => ProfileScreen(client: _client, onLogout: () => setState(() => _stage = 'pairing')),
              ),
            ),
          ),
          ConversationScreen(client: _client),
          MonitoringScreen(client: _client),
          RemindersScreen(client: _client),
          AlertsScreen(client: _client),
        ];

        return Scaffold(
          appBar: AppBar(title: const Text('FRIDAY Companion')),
          body: screens[_tabIndex],
          bottomNavigationBar: NavigationBar(
            selectedIndex: _tabIndex,
            onDestinationSelected: (i) => setState(() => _tabIndex = i),
            destinations: const [
              NavigationDestination(icon: Icon(Icons.dashboard), label: 'Home'),
              NavigationDestination(icon: Icon(Icons.chat), label: 'Chat'),
              NavigationDestination(icon: Icon(Icons.monitor_heart), label: 'Monitor'),
              NavigationDestination(icon: Icon(Icons.alarm), label: 'Reminders'),
              NavigationDestination(icon: Icon(Icons.notifications), label: 'Alerts'),
            ],
          ),
        );
      },
    );
  }
}
