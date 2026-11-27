// ============================================================
// FRIDAY — API Routes: /friday/trading/*
// Authenticated, owner-isolated Trading Copilot endpoints
// (Analysis & decision support ONLY — NO order execution)
// ============================================================

import { Router } from 'express';
import { requireCallerIdentity } from '../authContext';
import { toMinorUnits } from '../../finance/money';
import { runBacktest } from '../../trading/backtester';
import { getCapitalRiskManager } from '../../trading/capitalRiskManager';
import { getTradingJournalService } from '../../trading/journalAlerts';
import { getMarketDataProvider, normalizeAndValidateCandles } from '../../trading/marketData';
import { evaluateStrategies } from '../../trading/strategyEngine';
import { ExchangeCode, OhlcvCandle, Timeframe } from '../../trading/tradingTypes';

export const tradingRoutes = Router();

tradingRoutes.get('/overview', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const mgr = getCapitalRiskManager();
  const journalSvc = getTradingJournalService();
  const [session, riskConfig, watchlist, journal] = await Promise.all([
    mgr.getSessionCapital(identity.actorId),
    mgr.getRiskConfig(identity.actorId),
    journalSvc.listWatchlist(identity.actorId),
    journalSvc.listJournal(identity.actorId, 30),
  ]);
  res.json({ session, riskConfig, watchlist, journal });
});

tradingRoutes.post('/capital/confirm', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const session = await getCapitalRiskManager().confirmSessionCapital(identity.actorId, req.body);
    res.status(201).json({ session });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

tradingRoutes.get('/capital/snapshots', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const snapshots = await getCapitalRiskManager().getCapitalSnapshots(identity.actorId);
  res.json({ snapshots });
});

tradingRoutes.get('/risk-config', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const riskConfig = await getCapitalRiskManager().getRiskConfig(identity.actorId);
  res.json({ riskConfig });
});

tradingRoutes.put('/risk-config', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const riskConfig = await getCapitalRiskManager().setRiskConfig(identity.actorId, req.body);
    res.json({ riskConfig });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

tradingRoutes.get('/watchlist', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const watchlist = await getTradingJournalService().listWatchlist(identity.actorId);
  res.json({ watchlist });
});

tradingRoutes.post('/watchlist', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const item = await getTradingJournalService().addWatchlistItem(identity.actorId, req.body);
    res.status(201).json({ item });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

tradingRoutes.post('/analyze', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const { symbol, exchange = 'NSE', timeframe = '5m', candles } = req.body || {};
  if (!symbol || typeof symbol !== 'string') {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const ex: ExchangeCode = exchange === 'BSE' ? 'BSE' : 'NSE';
  const tf: Timeframe = timeframe === '15m' || timeframe === '1h' ? timeframe : '5m';
  const sym = symbol.trim().toUpperCase();

  const series = Array.isArray(candles)
    ? normalizeAndValidateCandles({
        instrument: {
          exchange: ex,
          symbol: sym,
          name: sym,
          instrumentType: 'CASH_EQUITY',
          sector: 'GENERAL',
          lotSize: 1,
          tickSizeMinor: 5,
        },
        timeframe: tf,
        sourceName: 'UserSuppliedCandles',
        declaredQuality: 'HISTORICAL_FIXTURE',
        rawCandles: candles as OhlcvCandle[],
      })
    : await getMarketDataProvider().getCandles(ex, sym, tf);

  const evalResult = evaluateStrategies(series);
  res.json({ series, ...evalResult });
});

tradingRoutes.post('/position-size', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const { symbol, exchange = 'NSE', direction, entryPrice, stopLoss, target } = req.body || {};
    const sizing = await getCapitalRiskManager().validateAndSizeCandidate(identity.actorId, {
      instrument: {
        exchange: exchange === 'BSE' ? 'BSE' : 'NSE',
        symbol: String(symbol || '').trim().toUpperCase(),
        name: String(symbol || '').trim().toUpperCase(),
        instrumentType: 'CASH_EQUITY',
        sector: 'GENERAL',
        lotSize: 1,
        tickSizeMinor: 5,
      },
      direction: direction === 'SHORT' ? 'SHORT' : 'LONG',
      suggestedEntryMinor: toMinorUnits(entryPrice),
      stopLossMinor: toMinorUnits(stopLoss),
      targetMinor: toMinorUnits(target),
      dataQuality: 'HISTORICAL_FIXTURE',
    });
    res.json({ sizing });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

tradingRoutes.get('/journal', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const journal = await getTradingJournalService().listJournal(identity.actorId);
  res.json({ journal });
});

tradingRoutes.post('/journal', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const entry = await getTradingJournalService().recordJournalEntry(identity.actorId, req.body);
    res.status(201).json({ entry });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

tradingRoutes.post('/backtest', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const { symbol, exchange = 'NSE', timeframe = '5m', strategyId, candles } = req.body || {};
    const ex: ExchangeCode = exchange === 'BSE' ? 'BSE' : 'NSE';
    const tf: Timeframe = timeframe === '15m' || timeframe === '1h' ? timeframe : '5m';
    const sym = String(symbol || '').trim().toUpperCase();

    const series = Array.isArray(candles)
      ? normalizeAndValidateCandles({
          instrument: {
            exchange: ex,
            symbol: sym,
            name: sym,
            instrumentType: 'CASH_EQUITY',
            sector: 'GENERAL',
            lotSize: 1,
            tickSizeMinor: 5,
          },
          timeframe: tf,
          sourceName: 'UserSuppliedCandles',
          declaredQuality: 'HISTORICAL_FIXTURE',
          rawCandles: candles as OhlcvCandle[],
        })
      : await getMarketDataProvider().getCandles(ex, sym, tf);

    const result = await runBacktest({
      ownerId: identity.actorId,
      instrument: series.instrument,
      timeframe: tf,
      candles: series.candles,
      strategyId: String(strategyId),
    });
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
