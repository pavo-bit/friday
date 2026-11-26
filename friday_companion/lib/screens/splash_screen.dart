import 'package:flutter/material.dart';
import '../services/friday_api_client.dart';

class SplashScreen extends StatefulWidget {
  final FridayApiClient client;
  final VoidCallback onReadyPaired;
  final VoidCallback onNeedsPairing;

  const SplashScreen({
    super.key,
    required this.client,
    required this.onReadyPaired,
    required this.onNeedsPairing,
  });

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    Future.delayed(const Duration(milliseconds: 500), () async {
      if (widget.client.bearerToken != null && widget.client.bearerToken!.isNotEmpty) {
        await widget.client.checkHealth();
        if (mounted) widget.onReadyPaired();
      } else {
        if (mounted) widget.onNeedsPairing();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            CircleAvatar(
              radius: 36,
              backgroundColor: Color(0xFF1D4ED8),
              child: Text('F', style: TextStyle(fontSize: 32, fontWeight: FontWeight.bold, color: Colors.white)),
            ),
            SizedBox(height: 16),
            Text('FRIDAY', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold, letterSpacing: 3)),
            SizedBox(height: 8),
            Text('Local-first Personal AI Companion', style: TextStyle(color: Colors.grey)),
          ],
        ),
      ),
    );
  }
}
