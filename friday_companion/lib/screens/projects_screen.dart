import 'package:flutter/material.dart';
import '../services/friday_api_client.dart';

class ProjectsScreen extends StatefulWidget {
  final FridayApiClient client;
  const ProjectsScreen({super.key, required this.client});

  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  List<Map<String, dynamic>> _projects = [];
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
      final res = await widget.client.listProjects();
      if (mounted) {
        setState(() {
          _projects = List<Map<String, dynamic>>.from(res['projects'] ?? const []);
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

  Future<void> _switch(String name) async {
    await widget.client.switchProject(name);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Project Contexts'),
        actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _load)],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : _projects.isEmpty
                  ? const Center(child: Text('No connected projects found.'))
                  : ListView.builder(
                      padding: const EdgeInsets.all(12),
                      itemCount: _projects.length,
                      itemBuilder: (_, i) {
                        final p = _projects[i];
                        final active = p['isActive'] == true;
                        final stack = (p['techStack'] as List<dynamic>? ?? []).join(', ');
                        return Card(
                          child: ListTile(
                            title: Text('${p['projectName']} ${active ? '(ACTIVE)' : ''}'),
                            subtitle: Text('${stack.isEmpty ? 'General' : stack} · ${p['progressSummary'] ?? ''}'),
                            trailing: active
                                ? const Icon(Icons.check_circle, color: Colors.greenAccent)
                                : TextButton(
                                    onPressed: () => _switch(p['projectName'].toString()),
                                    child: const Text('Switch'),
                                  ),
                          ),
                        );
                      },
                    ),
    );
  }
}
