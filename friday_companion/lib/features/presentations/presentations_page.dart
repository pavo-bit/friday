import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';

class PresentationsPage extends ConsumerStatefulWidget {
  const PresentationsPage({super.key});

  @override
  ConsumerState<PresentationsPage> createState() => _PresentationsPageState();
}

class _PresentationsPageState extends ConsumerState<PresentationsPage> {
  List<Map<String, dynamic>> _items = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final list = await ref.read(companionApiProvider).listPresentations();
      if (mounted) setState(() => _items = list);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Verified Result Deck'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(_error!, style: const TextStyle(color: FridayTheme.warning)),
                  ),
                )
              : _items.isEmpty
                  ? const Center(
                      child: Text(
                        'No verified presentations yet.',
                        style: TextStyle(color: FridayTheme.textMuted),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: _items.length,
                      itemBuilder: (_, idx) {
                        final p = _items[idx];
                        final status = (p['verificationStatus'] ?? 'UNVERIFIED').toString();
                        final prov = p['provenance'] is List && (p['provenance'] as List).isNotEmpty
                            ? (p['provenance'] as List).first as Map
                            : null;
                        return Card(
                          margin: const EdgeInsets.only(bottom: 12),
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                  children: [
                                    Expanded(
                                      child: Text(
                                        '[${(p['presentationType'] ?? 'summary').toString().toUpperCase()}] ${p['title'] ?? ''}',
                                        style: const TextStyle(fontWeight: FontWeight.w700),
                                      ),
                                    ),
                                    Text(
                                      status,
                                      style: TextStyle(
                                        fontSize: 12,
                                        fontWeight: FontWeight.w600,
                                        color: status == 'VERIFIED'
                                            ? FridayTheme.success
                                            : FridayTheme.cyanAccent,
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 8),
                                Text(p['summary']?.toString() ?? ''),
                                if (prov != null) ...[
                                  const SizedBox(height: 8),
                                  Text(
                                    'Source: ${prov['sourceName'] ?? '--'} · ${prov['freshnessLabel'] ?? '--'}',
                                    style: const TextStyle(
                                      fontSize: 11.5,
                                      color: FridayTheme.textMuted,
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        );
                      },
                    ),
    );
  }
}
