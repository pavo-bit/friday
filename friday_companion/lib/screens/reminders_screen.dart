import 'package:flutter/material.dart';
import '../models/friday_models.dart';
import '../services/friday_api_client.dart';

class RemindersScreen extends StatefulWidget {
  final FridayApiClient client;
  const RemindersScreen({super.key, required this.client});

  @override
  State<RemindersScreen> createState() => _RemindersScreenState();
}

class _RemindersScreenState extends State<RemindersScreen> {
  List<ReminderItem> _items = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await widget.client.listReminders();
      if (mounted)
        setState(() {
          _items = list;
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
        itemCount: _items.isEmpty ? 1 : _items.length,
        itemBuilder: (_, idx) {
          if (_items.isEmpty)
            return const ListTile(title: Text('No reminders scheduled.'));
          final r = _items[idx];
          return Card(
            child: ListTile(
              leading: Icon(r.isAlarm ? Icons.alarm : Icons.event_note),
              title: Text(r.title),
              subtitle: Text(
                  '${r.dueAt ?? 'Location trigger'} · ${r.recurrence} · ${r.status}'),
            ),
          );
        },
      ),
    );
  }
}
