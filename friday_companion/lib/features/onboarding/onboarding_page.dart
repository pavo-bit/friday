import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';

class OnboardingPage extends ConsumerWidget {
  const OnboardingPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Spacer(),
              const Text(
                'WELCOME TO FRIDAY',
                style: TextStyle(
                  color: FridayTheme.cyanAccent,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 1.8,
                ),
              ),
              const SizedBox(height: 10),
              const Text(
                'Your Local-First Personal Assistant',
                style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 18),
              _infoCard(
                Icons.laptop_mac,
                'Connected Mode',
                'Pairs securely with your laptop FRIDAY intelligence host (Ollama + Claw runtime) over LAN or private Tailscale.',
              ),
              const SizedBox(height: 12),
              _infoCard(
                Icons.smartphone,
                'Standalone Mode',
                'When your laptop is offline, inspect phone battery/device status, cached history, and local activity without cloud fallbacks.',
              ),
              const SizedBox(height: 12),
              _infoCard(
                Icons.verified_user,
                'Privacy & Explicit Control',
                'Zero paid AI APIs. Credentials are stored in Android Keystore-backed storage.',
              ),
              const Spacer(),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () async {
                    await ref
                        .read(companionControllerProvider)
                        .completeOnboarding();
                    if (context.mounted) context.go('/pairing');
                  },
                  child: const Padding(
                    padding: EdgeInsets.symmetric(vertical: 14),
                    child: Text('Continue to Device Pairing'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _infoCard(IconData icon, String title, String body) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: FridayTheme.cyanAccent),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(
                          fontWeight: FontWeight.w600, fontSize: 15)),
                  const SizedBox(height: 4),
                  Text(body,
                      style: const TextStyle(
                          color: FridayTheme.textMuted, fontSize: 13)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
