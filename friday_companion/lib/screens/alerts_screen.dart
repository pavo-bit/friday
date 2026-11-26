import 'package:flutter/material.dart';
import '../models/friday_models.dart';
import '../services/friday_api_client.dart';

class AlertsScreen extends StatefulWidget {
  final FridayApiClient client;
  const AlertsScreen({super.key, required this.client});

  @override
  State<AlertsScreen> createState() => _AlertsScreenState();
}

class _AlertsScreenState extends State<AlertsScreen> {
  List<NotificationItem> _items = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await widget.client.listNotifications();
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
            return const ListTile(title: Text('No notifications yet.'));
          final n = _items[idx];
          return Card(
            child: ListTile(
              leading: Icon(
                n.severity == 'critical'
                    ? Icons.error
                    : Icons.notifications_active,
                color: n.severity == 'critical'
                    ? Colors.redAccent
                    : Colors.amberAccent,
              ),
              title: Text(n.title),
              subtitle: Text(n.message),
            ),
          );
        },
      ),
    );
  }
}
