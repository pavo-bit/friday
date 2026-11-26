import 'package:flutter/material.dart';
import '../models/friday_models.dart';
import '../services/friday_api_client.dart';

class MonitoringScreen extends StatefulWidget {
  final FridayApiClient client;
  const MonitoringScreen({super.key, required this.client});

  @override
  State<MonitoringScreen> createState() => _MonitoringScreenState();
}

class _MonitoringScreenState extends State<MonitoringScreen> {
  List<WatcherItem> _watchers = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await widget.client.listWatchers();
      if (mounted)
        setState(() {
          _watchers = list;
          _error = null;
        });
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null)
      return Center(
          child:
              Padding(padding: const EdgeInsets.all(20), child: Text(_error!)));
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _watchers.isEmpty ? 1 : _watchers.length,
        itemBuilder: (_, idx) {
          if (_watchers.isEmpty)
            return const ListTile(title: Text('No active watchers.'));
          final w = _watchers[idx];
          return Card(
            child: ListTile(
              title: Text('${w.name} (${w.health})'),
              subtitle: Text('${w.targetUrl} · ${w.status}'),
              trailing: PopupMenuButton<String>(
                onSelected: (action) async {
                  await widget.client.controlWatcher(w.id, action);
                  _load();
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'pause', child: Text('Pause')),
                  PopupMenuItem(value: 'resume', child: Text('Resume')),
                  PopupMenuItem(value: 'stop', child: Text('Stop')),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
