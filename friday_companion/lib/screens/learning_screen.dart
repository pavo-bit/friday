import 'package:flutter/material.dart';
import '../services/friday_api_client.dart';

class LearningScreen extends StatefulWidget {
  final FridayApiClient client;
  const LearningScreen({super.key, required this.client});

  @override
  State<LearningScreen> createState() => _LearningScreenState();
}

class _LearningScreenState extends State<LearningScreen> {
  List<Map<String, dynamic>> _records = [];
  List<Map<String, dynamic>> _procedures = [];
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
      final recs = await widget.client.listLearningRecords();
      final procs = await widget.client.listProcedures();
      if (mounted) {
        setState(() {
          _records = recs;
          _procedures = procs;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Learning & Approvals'),
        actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _load)],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : ListView(
                  padding: const EdgeInsets.all(12),
                  children: [
                    const Text('Learned Procedures', style: TextStyle(fontWeight: FontWeight.bold)),
                    const SizedBox(height: 6),
                    if (_procedures.isEmpty)
                      const Text('No procedures proposed yet.')
                    else
                      ..._procedures.map((p) {
                        final approved = p['approvedByUser'] == true;
                        return Card(
                          child: ListTile(
                            title: Text(p['name'].toString()),
                            subtitle: Text(p['description'].toString()),
                            trailing: approved
                                ? const Icon(Icons.verified, color: Colors.greenAccent)
                                : ElevatedButton(
                                    onPressed: () async {
                                      await widget.client.approveProcedure(p['id'].toString());
                                      _load();
                                    },
                                    child: const Text('Approve'),
                                  ),
                          ),
                        );
                      }),
                    const SizedBox(height: 16),
                    const Text('Recent Knowledge Records', style: TextStyle(fontWeight: FontWeight.bold)),
                    const SizedBox(height: 6),
                    if (_records.isEmpty)
                      const Text('No knowledge records yet.')
                    else
                      ..._records.map((r) => Card(
                            child: ListTile(
                              title: Text('[${r['learningKind']}] ${r['subject']}'),
                              subtitle: Text('${r['content']} (${r['sourceQuality']})'),
                            ),
                          )),
                  ],
                ),
    );
  }
}
