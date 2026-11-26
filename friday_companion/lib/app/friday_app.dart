import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'app_theme.dart';
import 'router.dart';

class FridayCompanionApp extends ConsumerWidget {
  const FridayCompanionApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);
    return MaterialApp.router(
      title: 'FRIDAY Companion',
      debugShowCheckedModeBanner: false,
      theme: FridayTheme.dark(),
      routerConfig: router,
    );
  }
}
