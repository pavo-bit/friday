import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../features/activity_history/activity_history_page.dart';
import '../features/approvals/approvals_page.dart';
import '../features/assistant/assistant_page.dart';
import '../features/connection/connection_settings_page.dart';
import '../features/dashboard/dashboard_page.dart';
import '../features/device_monitoring/screen_share_page.dart';
import '../features/device_pairing/pairing_page.dart';
import '../features/finance/finance_page.dart';
import '../features/onboarding/onboarding_page.dart';
import '../features/onboarding/splash_page.dart';
import '../features/presentations/presentations_page.dart';
import '../features/settings/app_settings_page.dart';
import '../features/trading/trading_page.dart';

final appRouterProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/splash',
    routes: [
      GoRoute(path: '/splash', builder: (_, __) => const SplashPage()),
      GoRoute(path: '/onboarding', builder: (_, __) => const OnboardingPage()),
      GoRoute(path: '/pairing', builder: (_, __) => const PairingPage()),
      GoRoute(path: '/dashboard', builder: (_, __) => const DashboardPage()),
      GoRoute(path: '/assistant', builder: (_, __) => const AssistantPage()),
      GoRoute(path: '/approvals', builder: (_, __) => const ApprovalsPage()),
      GoRoute(path: '/presentations', builder: (_, __) => const PresentationsPage()),
      GoRoute(path: '/finance', builder: (_, __) => const FinancePage()),
      GoRoute(path: '/trading', builder: (_, __) => const TradingPage()),
      GoRoute(path: '/screen-share', builder: (_, __) => const ScreenSharePage()),
      GoRoute(
          path: '/connection',
          builder: (_, __) => const ConnectionSettingsPage()),
      GoRoute(
          path: '/activity', builder: (_, __) => const ActivityHistoryPage()),
      GoRoute(path: '/settings', builder: (_, __) => const AppSettingsPage()),
    ],
  );
});
