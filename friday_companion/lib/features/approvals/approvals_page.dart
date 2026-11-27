import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';

class ApprovalsPage extends ConsumerStatefulWidget {
  const ApprovalsPage({super.key});

  @override
  ConsumerState<ApprovalsPage> createState() => _ApprovalsPageState();
}

class _ApprovalsPageState extends ConsumerState<ApprovalsPage> {
  List<Map<String, dynamic>> _approvals = const [];
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
      final list = await ref.read(companionApiProvider).listPendingApprovals();
      if (mounted) setState(() => _approvals = list);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _resolve(String approvalId, bool approve) async {
    final api = ref.read(companionApiProvider);
    if (approve) {
      await api.approveAction(approvalId, resolution: 'Confirmed on Android companion');
    } else {
      await api.rejectAction(approvalId, reason: 'Rejected on Android companion');
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Pending Approvals'),
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
              : _approvals.isEmpty
                  ? const Center(
                      child: Text(
                        'No pending bound approvals.',
                        style: TextStyle(color: FridayTheme.textMuted),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: _approvals.length,
                      itemBuilder: (_, idx) {
                        final a = _approvals[idx];
                        final id = a['approvalId']?.toString() ?? '';
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
                                        a['capabilityId']?.toString() ?? 'Capability',
                                        style: const TextStyle(
                                          fontWeight: FontWeight.w700,
                                          color: FridayTheme.cyanAccent,
                                        ),
                                      ),
                                    ),
                                    Chip(
                                      label: Text(
                                        (a['riskLevel'] ?? 'high').toString().toUpperCase(),
                                        style: const TextStyle(fontSize: 11),
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 8),
                                Text(a['summary']?.toString() ?? 'Requires explicit confirmation.'),
                                const SizedBox(height: 6),
                                Text(
                                  'Scope: ${a['permissionScope'] ?? 'default'} · Device: ${a['deviceId'] ?? 'unknown'}\nExpires: ${a['expiresAt'] ?? '--'}',
                                  style: const TextStyle(fontSize: 12, color: FridayTheme.textMuted),
                                ),
                                const SizedBox(height: 12),
                                Row(
                                  children: [
                                    FilledButton(
                                      onPressed: () => _resolve(id, true),
                                      child: const Text('Approve'),
                                    ),
                                    const SizedBox(width: 10),
                                    OutlinedButton(
                                      onPressed: () => _resolve(id, false),
                                      child: const Text('Reject'),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
    );
  }
}
