import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';
import '../../core/networking/connection_state.dart';

class DashboardPage extends ConsumerWidget {
  const DashboardPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conn = ref.watch(connectionStateProvider);
    final telemetryAsync = ref.watch(phoneTelemetryProvider);
    final messages = ref.watch(cachedMessagesProvider);
    final activities = ref.watch(activityHistoryProvider);

    final hour = DateTime.now().hour;
    final greeting = hour >= 5 && hour < 12
        ? 'Good morning, Boss.'
        : hour >= 12 && hour < 17
            ? 'Good afternoon, Boss.'
            : hour >= 17 && hour < 21
                ? 'Good evening, Boss.'
                : 'Good night, Boss.';

    final statusColor = switch (conn.status) {
      ConnectionStatus.connected => FridayTheme.success,
      ConnectionStatus.connecting ||
      ConnectionStatus.reconnecting =>
        FridayTheme.warning,
      ConnectionStatus.disconnected ||
      ConnectionStatus.authRequired =>
        FridayTheme.danger,
    };

    return Scaffold(
      appBar: AppBar(
        title: const Text('FRIDAY Command Center'),
        actions: [
          IconButton(
            tooltip: 'Refresh connection',
            icon: const Icon(Icons.refresh),
            onPressed: () {
              ref.read(companionControllerProvider).checkConnection();
              ref.invalidate(phoneTelemetryProvider);
            },
          ),
          IconButton(
            tooltip: 'Settings',
            icon: const Icon(Icons.settings),
            onPressed: () => context.push('/settings'),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              greeting,
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
            ),
          ),
          // Explicit Connection State Card
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                            color: statusColor, shape: BoxShape.circle),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          conn.label,
                          style: const TextStyle(
                              fontSize: 16, fontWeight: FontWeight.w700),
                        ),
                      ),
                      TextButton(
                        onPressed: () => context.push('/connection'),
                        child: const Text('Configure'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    conn.isConnected
                        ? 'Primary local AI host online at ${conn.serverUrl}'
                        : (conn.detail ??
                            "FRIDAY's local brain is offline. Standalone phone capabilities remain available."),
                    style: const TextStyle(
                        color: FridayTheme.textMuted, fontSize: 13),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),

          // Phone-Native Telemetry Card (Available in both Connected & Standalone modes)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: telemetryAsync.when(
                data: (t) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'PHONE TELEMETRY (STANDALONE-READY)',
                      style: TextStyle(
                        fontSize: 11,
                        color: FridayTheme.cyanAccent,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 1.2,
                      ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text('Device: ${t.deviceModel}',
                            style:
                                const TextStyle(fontWeight: FontWeight.w500)),
                        Text(
                          t.batteryLevel != null
                              ? '${t.batteryLevel}% (${t.batteryState})'
                              : 'Battery N/A',
                          style: const TextStyle(
                              color: FridayTheme.cyanAccent,
                              fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text('OS: ${t.osVersion}',
                        style: const TextStyle(
                            color: FridayTheme.textMuted, fontSize: 12)),
                  ],
                ),
                loading: () => const LinearProgressIndicator(),
                error: (e, _) => Text('Telemetry unavailable: $e'),
              ),
            ),
          ),
          const SizedBox(height: 14),

          // Navigation Grid
          GridView.count(
            crossAxisCount: 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            childAspectRatio: 1.55,
            children: [
              _navCard(
                context,
                Icons.chat_bubble_outline,
                'Assistant',
                conn.isConnected
                    ? 'Local Ollama ready'
                    : 'Cached (${messages.length} msgs)',
                () => context.push('/assistant'),
              ),
              _navCard(
                context,
                Icons.verified_outlined,
                'Verified Results',
                'Presentations & trace',
                () => context.push('/presentations'),
              ),
              _navCard(
                context,
                Icons.gavel_outlined,
                'Approvals',
                'Bound action confirmation',
                () => context.push('/approvals'),
              ),
              _navCard(
                context,
                Icons.account_balance_wallet_outlined,
                'Finance',
                'Ledger, budgets & goals',
                () => context.push('/finance'),
              ),
              _navCard(
                context,
                Icons.candlestick_chart_outlined,
                'Trading Copilot',
                'NSE/BSE risk & journal',
                () => context.push('/trading'),
              ),
              _navCard(
                context,
                Icons.screen_share_outlined,
                'Screen & Privacy',
                'Explicit MediaProjection',
                () => context.push('/screen-share'),
              ),
              _navCard(
                context,
                Icons.hub_outlined,
                'Connection',
                conn.serverUrl,
                () => context.push('/connection'),
              ),
              _navCard(
                context,
                Icons.history,
                'Activity History',
                '${activities.length} local records',
                () => context.push('/activity'),
              ),
              _navCard(
                context,
                Icons.tune,
                'App Settings',
                conn.isPaired ? 'Paired device' : 'Not paired',
                () => context.push('/settings'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _navCard(
    BuildContext context,
    IconData icon,
    String title,
    String subtitle,
    VoidCallback onTap,
  ) {
    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Icon(icon, color: FridayTheme.cyanAccent),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(
                          fontWeight: FontWeight.w600, fontSize: 15)),
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        color: FridayTheme.textMuted, fontSize: 12),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
