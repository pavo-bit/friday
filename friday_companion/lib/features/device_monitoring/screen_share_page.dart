import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';

class ScreenSharePage extends ConsumerWidget {
  const ScreenSharePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final share = ref.watch(screenShareProvider);
    final privacy = ref.watch(permissionPrivacyProvider);
    final shareCtrl = ref.read(screenShareProvider.notifier);
    final privCtrl = ref.read(permissionPrivacyProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: const Text('Screen Sharing & Device Privacy')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text('Explicit Screen Sharing (MediaProjection)',
                          style: TextStyle(fontWeight: FontWeight.w700)),
                      Text(
                        share.status.name.toUpperCase(),
                        style: TextStyle(
                          fontSize: 12,
                          color: share.isActive ? FridayTheme.danger : FridayTheme.cyanAccent,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    share.statusMessage ??
                        'Requires manual start, Android MediaProjection consent, and foreground notification. Never runs silently in background.',
                    style: const TextStyle(fontSize: 13, color: FridayTheme.textMuted),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      if (!share.isActive)
                        FilledButton.icon(
                          icon: const Icon(Icons.screen_share),
                          label: const Text('Start Session'),
                          onPressed: () async {
                            final ok = await showDialog<bool>(
                              context: context,
                              builder: (ctx) => AlertDialog(
                                title: const Text('MediaProjection Consent'),
                                content: const Text(
                                  'Share your screen for this explicit session only? A persistent foreground notification and stop control will remain visible.',
                                ),
                                actions: [
                                  TextButton(
                                    onPressed: () => Navigator.pop(ctx, false),
                                    child: const Text('Cancel'),
                                  ),
                                  FilledButton(
                                    onPressed: () => Navigator.pop(ctx, true),
                                    child: const Text('Allow Session'),
                                  ),
                                ],
                              ),
                            );
                            if (ok == true) {
                              await shareCtrl.startSession(
                                manualUserInitiated: true,
                                androidConsentGranted: true,
                              );
                            }
                          },
                        ),
                      if (share.isActive)
                        FilledButton.icon(
                          style: FilledButton.styleFrom(backgroundColor: FridayTheme.danger),
                          icon: const Icon(Icons.stop_screen_share),
                          label: const Text('Stop Sharing'),
                          onPressed: () => shareCtrl.stopSession(),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Card(
            child: Column(
              children: [
                SwitchListTile(
                  title: const Text('Microphone (Voice Input Only)'),
                  subtitle: const Text('Enabled only while using voice commands'),
                  value: privacy.microphoneEnabled,
                  onChanged: privCtrl.setMicrophone,
                ),
                SwitchListTile(
                  title: const Text('Notification Access (Disabled by Default)'),
                  subtitle: const Text('Metadata-only unless content opt-in is enabled'),
                  value: privacy.notificationAccessEnabled,
                  onChanged: privCtrl.setNotificationAccess,
                ),
                SwitchListTile(
                  title: const Text('Notification Content Opt-In'),
                  subtitle: const Text('Separate opt-in required to read notification bodies'),
                  value: privacy.notificationContentOptIn,
                  onChanged: privacy.notificationAccessEnabled
                      ? privCtrl.setNotificationContentOptIn
                      : null,
                ),
                SwitchListTile(
                  title: const Text('Usage Access'),
                  subtitle: const Text('Granted explicitly via Android settings'),
                  value: privacy.usageAccessEnabled,
                  onChanged: privCtrl.setUsageAccess,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
