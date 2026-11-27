// ============================================================
// FRIDAY — Deterministic Historical Backtester
// Zero look-ahead bias, transaction charges, slippage & OOS split
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { formatMinorUnits } from '../finance/money';
import { estimateIntradayChargesMinor } from './capitalRiskManager';
import { analyzeIndicators } from './indicators';
import { BUILTIN_STRATEGIES, TradingStrategy } from './strategyEngine';
import { InstrumentMetadata, OhlcvCandle, Timeframe } from './tradingTypes';

export interface BacktestMetrics {
  tradesCount: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinMinor: number;
  avgLossMinor: number;
  profitFactor: number;
  maxDrawdownMinor: number;
  maxDrawdownPct: number;
  expectancyMinor: number;
  totalNetPnlMinor: number;
  totalNetPnlFormatted: string;
  totalChargesMinor: number;
  totalChargesFormatted: string;
  benchmarkReturnPct: number;
}

export interface BacktestResult {
  runId: string;
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  timeframe: Timeframe;
  isHistoricalSimulation: true;
  disclaimer: string;
  inSample: BacktestMetrics;
  metrics?: BacktestMetrics;
  outOfSample: BacktestMetrics | null;
}

function simulateSlice(params: {
  instrument: InstrumentMetadata;
  timeframe: Timeframe;
  candles: OhlcvCandle[];
  strategy: TradingStrategy;
  initialCapitalMinor: number;
  slippageBps: number;
  quantity: number;
}): BacktestMetrics {
  const { candles, strategy, initialCapitalMinor, slippageBps, quantity } = params;
  const pnls: number[] = [];
  let totalChargesMinor = 0;
  let equity = initialCapitalMinor;
  let peak = initialCapitalMinor;
  let maxDrawdownMinor = 0;

  let i = 15;
  while (i < candles.length - 1) {
    // Strictly only bars [0..i] are visible at decision time (no look-ahead)
    const visible = candles.slice(0, i + 1);
    const ind = analyzeIndicators(visible);
    const candidate = strategy.evaluate(
      {
        instrument: params.instrument,
        timeframe: params.timeframe,
        sourceName: 'BacktestHistoricalSlice',
        quality: 'HISTORICAL_FIXTURE',
        exchangeTimestamp: visible[visible.length - 1].timestamp,
        receivedTimestamp: visible[visible.length - 1].timestamp,
        freshnessSeconds: 0,
        stale: false,
        missingCandlesDetected: 0,
        duplicatesRemoved: 0,
        candles: visible,
        warnings: [],
      },
      ind
    );

    if (!candidate) {
      i++;
      continue;
    }

    // Enter on bar i+1 open with slippage
    const entryBar = candles[i + 1];
    const slipPerShare = Math.round((entryBar.openMinor * slippageBps) / 10_000);
    const entryPrice =
      candidate.direction === 'LONG'
        ? entryBar.openMinor + slipPerShare
        : entryBar.openMinor - slipPerShare;

    let exitPrice = candles[candles.length - 1].closeMinor;
    let exitIdx = candles.length - 1;

    for (let j = i + 1; j < candles.length; j++) {
      const bar = candles[j];
      if (candidate.direction === 'LONG') {
        // Conservative: check gap-through stop-loss, then intrabar stop-loss, then target
        if (bar.openMinor <= candidate.stopLossMinor) {
          exitPrice = bar.openMinor - slipPerShare;
          exitIdx = j;
          break;
        }
        if (bar.lowMinor <= candidate.stopLossMinor) {
          exitPrice = candidate.stopLossMinor - slipPerShare;
          exitIdx = j;
          break;
        }
        if (bar.highMinor >= candidate.targetMinor) {
          exitPrice = candidate.targetMinor - slipPerShare;
          exitIdx = j;
          break;
        }
      } else {
        if (bar.openMinor >= candidate.stopLossMinor) {
          exitPrice = bar.openMinor + slipPerShare;
          exitIdx = j;
          break;
        }
        if (bar.highMinor >= candidate.stopLossMinor) {
          exitPrice = candidate.stopLossMinor + slipPerShare;
          exitIdx = j;
          break;
        }
        if (bar.lowMinor <= candidate.targetMinor) {
          exitPrice = candidate.targetMinor + slipPerShare;
          exitIdx = j;
          break;
        }
      }
    }

    const grossPnl =
      candidate.direction === 'LONG'
        ? (exitPrice - entryPrice) * quantity
        : (entryPrice - exitPrice) * quantity;
    const charges = estimateIntradayChargesMinor(entryPrice, exitPrice, quantity);
    const netPnl = grossPnl - charges;

    totalChargesMinor += charges;
    pnls.push(netPnl);
    equity += netPnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownMinor) maxDrawdownMinor = dd;

    i = exitIdx + 1;
  }

  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const totalNet = pnls.reduce((a, b) => a + b, 0);

  return {
    tradesCount: pnls.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: pnls.length > 0 ? Math.round((wins.length / pnls.length) * 10_000) / 100 : 0,
    avgWinMinor: wins.length > 0 ? Math.round(grossWin / wins.length) : 0,
    avgLossMinor: losses.length > 0 ? Math.round(grossLoss / losses.length) : 0,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 999 : 0,
    maxDrawdownMinor,
    maxDrawdownPct: peak > 0 ? Math.round((maxDrawdownMinor / peak) * 10_000) / 100 : 0,
    expectancyMinor: pnls.length > 0 ? Math.round(totalNet / pnls.length) : 0,
    totalNetPnlMinor: totalNet,
    totalNetPnlFormatted: formatMinorUnits(totalNet),
    totalChargesMinor,
    totalChargesFormatted: formatMinorUnits(totalChargesMinor),
    benchmarkReturnPct:
      candles.length >= 2 && candles[0].openMinor > 0
        ? Math.round(((candles[candles.length - 1].closeMinor - candles[0].openMinor) / candles[0].openMinor) * 10_000) / 100
        : 0,
  };
}

export async function runBacktest(params: {
  ownerId: string;
  instrument: InstrumentMetadata;
  timeframe: Timeframe;
  candles: OhlcvCandle[];
  strategyId: string;
  initialCapitalMinor?: number;
  slippageBps?: number;
  quantity?: number;
  inSampleRatio?: number;
}): Promise<BacktestResult> {
  const normalizedId = params.strategyId.replace(/-/g, '_');
  const strategy = BUILTIN_STRATEGIES.find((s) => s.id === params.strategyId || s.id === normalizedId);
  if (!strategy) {
    throw new Error(`Unknown strategy "${params.strategyId}"`);
  }

  const initialCapitalMinor = params.initialCapitalMinor ?? 10_000_000; // Rs 1,00,000
  const slippageBps = params.slippageBps ?? 5;
  const quantity = params.quantity ?? Math.max(1, params.instrument.lotSize || 1);
  const ratio = params.inSampleRatio ?? 0.7;
  const splitIdx = Math.floor(params.candles.length * ratio);

  const inCandles =
    ratio < 1 && splitIdx >= 20 && params.candles.length - splitIdx >= 20
      ? params.candles.slice(0, splitIdx)
      : params.candles;
  const outCandles =
    ratio < 1 && splitIdx >= 20 && params.candles.length - splitIdx >= 20
      ? params.candles.slice(splitIdx)
      : null;

  const inSample = simulateSlice({
    instrument: params.instrument,
    timeframe: params.timeframe,
    candles: inCandles,
    strategy,
    initialCapitalMinor,
    slippageBps,
    quantity,
  });

  const outOfSample = outCandles
    ? simulateSlice({
        instrument: params.instrument,
        timeframe: params.timeframe,
        candles: outCandles,
        strategy,
        initialCapitalMinor,
        slippageBps,
        quantity,
      })
    : null;

  const runId = uuidv4();
  const result: BacktestResult = {
    runId,
    strategyId: params.strategyId,
    strategyVersion: strategy.version,
    symbol: params.instrument.symbol,
    timeframe: params.timeframe,
    isHistoricalSimulation: true,
    disclaimer:
      'Historical simulation only. Past backtest performance does not guarantee future live trading results.',
    inSample,
    metrics: inSample,
    outOfSample,
  };

  const store = await getMemoryStore();
  const db = store.getDatabase();
  if (db) {
    db.prepare(
      `INSERT INTO trading_backtest_runs (
        id, owner_id, strategy_id, strategy_version, symbol, timeframe, metrics_json, trades_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      params.ownerId,
      strategy.id,
      strategy.version,
      params.instrument.symbol,
      params.timeframe,
      JSON.stringify(result),
      inSample.tradesCount + (outOfSample?.tradesCount ?? 0)
    );
  }

  return result;
}
