import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';
import '../../core/networking/connection_state.dart';

class SplashPage extends ConsumerStatefulWidget {
  const SplashPage({super.key});

  @override
  ConsumerState<SplashPage> createState() => _SplashPageState();
}

class _SplashPageState extends ConsumerState<SplashPage> {
  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    await ref.read(companionControllerProvider).bootstrap();
    if (!mounted) return;
    final onboardingDone = ref.read(onboardingCompleteProvider);
    final conn = ref.read(connectionStateProvider);

    if (!onboardingDone) {
      context.go('/onboarding');
    } else if (conn.status == ConnectionStatus.authRequired) {
      context.go('/pairing');
    } else {
      context.go('/dashboard');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment.center,
            radius: 0.9,
            colors: [Color(0xFF0F1F3D), FridayTheme.background],
          ),
        ),
        child: const Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              CircleAvatar(
                radius: 40,
                backgroundColor: FridayTheme.primary,
                child: Text(
                  'F',
                  style: TextStyle(
                      fontSize: 34,
                      fontWeight: FontWeight.bold,
                      color: Colors.white),
                ),
              ),
              SizedBox(height: 18),
              Text(
                'FRIDAY',
                style: TextStyle(
                    fontSize: 26,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 4),
              ),
              SizedBox(height: 8),
              Text(
                'Local-first Android Companion',
                style: TextStyle(color: FridayTheme.textMuted),
              ),
              SizedBox(height: 24),
              SizedBox(
                width: 24,
                height: 24,
                child: CircularProgressIndicator(
                    strokeWidth: 2, color: FridayTheme.cyanAccent),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
