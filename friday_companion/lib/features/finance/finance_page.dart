import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';

class FinancePage extends ConsumerStatefulWidget {
  const FinancePage({super.key});

  @override
  ConsumerState<FinancePage> createState() => _FinancePageState();
}

class _FinancePageState extends ConsumerState<FinancePage> {
  Map<String, dynamic>? _report;
  String? _cachedAt;
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
    final db = ref.read(localDatabaseProvider);
    try {
      final data = await ref.read(companionApiProvider).getFinanceOverview();
      final now = DateTime.now().toIso8601String();
      await db.saveCacheSnapshot('finance_overview', jsonEncode(data), now);
      if (mounted) {
        setState(() {
          _report = data;
          _cachedAt = null;
        });
      }
    } catch (e) {
      final cached = await db.getCacheSnapshot('finance_overview');
      if (cached != null && mounted) {
        setState(() {
          _report = jsonDecode(cached.payloadJson) as Map<String, dynamic>;
          _cachedAt = cached.updatedAt;
        });
      } else if (mounted) {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = _report;
    final cur = r?['currency']?.toString() ?? 'INR';
    final cf = (r?['cashFlow'] as Map?) ?? const {};
    final portfolio = (r?['portfolio'] as Map?) ?? const {};
    final budgets = List<Map<String, dynamic>>.from(r?['budgets'] ?? const []);
    final goals = List<Map<String, dynamic>>.from(r?['goals'] ?? const []);
    final debts = List<Map<String, dynamic>>.from(r?['debts'] ?? const []);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Financial Intelligence'),
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
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (_cachedAt != null)
                      Card(
                        color: FridayTheme.surfaceElevated,
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Text(
                            'Offline cached view · Last updated: $_cachedAt',
                            style: const TextStyle(color: FridayTheme.warning, fontSize: 12),
                          ),
                        ),
                      ),
                    Card(
                      child: ListTile(
                        title: const Text('Net Worth (User Ledger)'),
                        subtitle: const Text('Accounts + Portfolio - Debts · Source: USER_ENTERED'),
                        trailing: Text(
                          '$cur ${r?['netWorthFormatted'] ?? '0.00'}',
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w700,
                            color: FridayTheme.cyanAccent,
                          ),
                        ),
                      ),
                    ),
                    Card(
                      child: ListTile(
                        title: Text('Cash Flow (${cf['period'] ?? '--'})'),
                        subtitle: Text(
                          'Income: ${cf['totalIncomeFormatted'] ?? '0.00'} · Expense: ${cf['totalExpenseFormatted'] ?? '0.00'}',
                        ),
                        trailing: Text('$cur ${cf['netCashFlowFormatted'] ?? '0.00'}'),
                      ),
                    ),
                    Card(
                      child: ListTile(
                        title: const Text('Portfolio Summary'),
                        subtitle: Text(
                          'Holdings: ${portfolio['holdingsCount'] ?? 0} · Concentration: ${portfolio['concentrationRisk'] ?? 'none'}',
                        ),
                        trailing: Text('$cur ${portfolio['totalValueFormatted'] ?? '0.00'}'),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text('Budgets (${budgets.length})',
                        style: const TextStyle(fontWeight: FontWeight.w600)),
                    if (budgets.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 8),
                        child: Text('No budgets recorded.',
                            style: TextStyle(color: FridayTheme.textMuted)),
                      ),
                    ...budgets.map((b) => Card(
                          child: ListTile(
                            title: Text('${b['category']} (${b['utilizationPct']}%)'),
                            subtitle: Text('${b['spentFormatted']} / ${b['limitFormatted']} · ${b['sourceClassification']}'),
                          ),
                        )),
                    const SizedBox(height: 12),
                    Text('Savings Goals (${goals.length})',
                        style: const TextStyle(fontWeight: FontWeight.w600)),
                    ...goals.map((g) => Card(
                          child: ListTile(
                            title: Text('${g['name']} (${g['progressPct']}%)'),
                            subtitle: Text('${g['currentFormatted']} / ${g['targetFormatted']}'),
                          ),
                        )),
                    const SizedBox(height: 12),
                    Text('Debts (${debts.length})',
                        style: const TextStyle(fontWeight: FontWeight.w600)),
                    ...debts.map((d) => Card(
                          child: ListTile(
                            title: Text('${d['name']} (${d['aprPct']}% APR)'),
                            subtitle: Text('Remaining: ${d['remainingFormatted']}'),
                          ),
                        )),
                  ],
                ),
    );
  }
}
