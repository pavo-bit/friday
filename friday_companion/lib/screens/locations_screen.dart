import 'package:flutter/material.dart';
import '../models/friday_models.dart';
import '../services/friday_api_client.dart';

class LocationsScreen extends StatefulWidget {
  final FridayApiClient client;
  const LocationsScreen({super.key, required this.client});

  @override
  State<LocationsScreen> createState() => _LocationsScreenState();
}

class _LocationsScreenState extends State<LocationsScreen> {
  List<SavedLocationItem> _locations = [];
  final _nameCtrl = TextEditingController();
  final _latCtrl = TextEditingController();
  final _lonCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await widget.client.listLocations();
      if (mounted) setState(() => _locations = list);
    } catch (_) {}
  }

  Future<void> _save() async {
    final lat = double.tryParse(_latCtrl.text.trim());
    final lon = double.tryParse(_lonCtrl.text.trim());
    if (_nameCtrl.text.trim().isEmpty || lat == null || lon == null) return;
    await widget.client.saveLocation(name: _nameCtrl.text.trim(), latitude: lat, longitude: lon);
    _nameCtrl.clear();
    _latCtrl.clear();
    _lonCtrl.clear();
    _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Saved Locations & Geofences')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            TextField(controller: _nameCtrl, decoration: const InputDecoration(labelText: 'Location Name (e.g. college)')),
            Row(
              children: [
                Expanded(child: TextField(controller: _latCtrl, decoration: const InputDecoration(labelText: 'Latitude'))),
                const SizedBox(width: 8),
                Expanded(child: TextField(controller: _lonCtrl, decoration: const InputDecoration(labelText: 'Longitude'))),
              ],
            ),
            const SizedBox(height: 10),
            ElevatedButton(onPressed: _save, child: const Text('Save Geofence Location')),
            const Divider(height: 24),
            Expanded(
              child: ListView.builder(
                itemCount: _locations.length,
                itemBuilder: (_, idx) {
                  final loc = _locations[idx];
                  return ListTile(
                    leading: const Icon(Icons.place),
                    title: Text(loc.name),
                    subtitle: Text('${loc.latitude}, ${loc.longitude} (${loc.radiusMeters}m)'),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
