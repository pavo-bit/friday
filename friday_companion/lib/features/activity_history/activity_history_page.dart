import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';

class ActivityHistoryPage extends ConsumerWidget {
  const ActivityHistoryPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final activities = ref.watch(activityHistoryProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Local Activity History')),
      body: activities.isEmpty
          ? const Center(
              child: Text('No local activity recorded yet.',
                  style: TextStyle(color: FridayTheme.textMuted)),
            )
          : ListView.builder(
              padding: const EdgeInsets.all(12),
              itemCount: activities.length,
              itemBuilder: (_, idx) {
                final a = activities[idx];
                return Card(
                  child: ListTile(
                    title: Text(a.action),
                    subtitle:
                        Text('${a.detail}\nMode: ${a.mode} · ${a.createdAt}'),
                    isThreeLine: true,
                  ),
                );
              },
            ),
    );
  }
}
