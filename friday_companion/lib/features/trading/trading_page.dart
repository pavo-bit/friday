import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';

class TradingPage extends ConsumerStatefulWidget {
  const TradingPage({super.key});

  @override
  ConsumerState<TradingPage> createState() => _TradingPageState();
}

class _TradingPageState extends ConsumerState<TradingPage> {
  Map<String, dynamic>? _overview;
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
      final data = await ref.read(companionApiProvider).getTradingOverview();
      final now = DateTime.now().toIso8601String();
      await db.saveCacheSnapshot('trading_overview', jsonEncode(data), now);
      if (mounted) {
        setState(() {
          _overview = data;
          _cachedAt = null;
        });
      }
    } catch (e) {
      final cached = await db.getCacheSnapshot('trading_overview');
      if (cached != null && mounted) {
        setState(() {
          _overview = jsonDecode(cached.payloadJson) as Map<String, dynamic>;
          _cachedAt = cached.updatedAt;
        });
      } else if (mounted) {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _confirmCapitalDialog() async {
    final eqCtrl = TextEditingController();
    final cashCtrl = TextEditingController();
    final allocCtrl = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Confirm Session Trading Capital'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Explicit confirmation required. Updating capital does not raise daily loss limits.',
              style: TextStyle(fontSize: 12, color: FridayTheme.textMuted),
            ),
            const SizedBox(height: 10),
            TextField(controller: eqCtrl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Total Equity (INR)')),
            const SizedBox(height: 8),
            TextField(controller: cashCtrl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Available Cash (INR)')),
            const SizedBox(height: 8),
            TextField(controller: allocCtrl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Allocated Capital (INR)')),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Confirm')),
        ],
      ),
    );

    if (confirmed == true) {
      await ref.read(companionApiProvider).confirmTradingCapital(
            totalEquity: eqCtrl.text.trim(),
            availableCash: cashCtrl.text.trim(),
            allocatedCapital: allocCtrl.text.trim(),
            confirmedByUser: true,
          );
      await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = _overview?['session'] as Map?;
    final riskConfig = _overview?['riskConfig'] as Map?;
    final watchlist = List<Map<String, dynamic>>.from(_overview?['watchlist'] ?? const []);
    final journal = List<Map<String, dynamic>>.from(_overview?['journal'] ?? const []);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Trading Copilot (NSE/BSE)'),
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
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('Session Capital & Risk Budget',
                                style: TextStyle(fontWeight: FontWeight.w700)),
                            const SizedBox(height: 6),
                            Text(session != null
                                ? 'Allocated: ${session['currency']} ${((session['allocatedCapitalMinor'] as num) / 100).toStringAsFixed(2)}\nRemaining Daily Risk: ${session['currency']} ${((session['remainingDailyRiskMinor'] as num) / 100).toStringAsFixed(2)}'
                                : 'Session capital not confirmed yet.'),
                            const SizedBox(height: 6),
                            Text(
                              riskConfig != null
                                  ? 'Max risk/trade: ${((riskConfig['maxRiskPerTradeBps'] as num) / 100).toStringAsFixed(2)}% · Max daily loss: ${((riskConfig['maxDailyLossBps'] as num) / 100).toStringAsFixed(2)}%'
                                  : 'Risk configuration: Not set (required before sizing).',
                              style: const TextStyle(fontSize: 12, color: FridayTheme.textMuted),
                            ),
                            const SizedBox(height: 10),
                            FilledButton(
                              onPressed: _cachedAt == null ? _confirmCapitalDialog : null,
                              child: const Text('Confirm Session Capital'),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    const Card(
                      child: ListTile(
                        title: Text('Market Data Feed: NO LIVE FEED'),
                        subtitle: Text('Analysis uses historical fixtures or user-supplied candles. Decision support only — no autonomous broker execution.'),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text('Watchlist (${watchlist.length})',
                        style: const TextStyle(fontWeight: FontWeight.w600)),
                    ...watchlist.map((w) => Card(
                          child: ListTile(
                            title: Text('${w['exchange']}:${w['symbol']}'),
                            subtitle: Text('${w['instrumentType']} · ${w['sector']}'),
                          ),
                        )),
                    const SizedBox(height: 12),
                    Text('Trading Journal (${journal.length})',
                        style: const TextStyle(fontWeight: FontWeight.w600)),
                    ...journal.map((j) => Card(
                          child: ListTile(
                            title: Text('${j['exchange']}:${j['symbol']} ${j['side']} x${j['quantity']}'),
                            subtitle: Text('Entry ${j['entryPriceFormatted']} · P&L ${j['realizedPnlFormatted']} · ${j['sourceClassification']}'),
                          ),
                        )),
                  ],
                ),
    );
  }
}
