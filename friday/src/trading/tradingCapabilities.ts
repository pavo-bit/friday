// ============================================================
// FRIDAY — Trading Copilot Capabilities
// Registered in CapabilityRegistry (analysis & sizing only; NO order placement)
// ============================================================

import { formatMinorUnits, toMinorUnits } from '../finance/money';
import type { CapabilityRegistry } from '../orchestration/toolRegistry';
import { runBacktest } from './backtester';
import { getCapitalRiskManager } from './capitalRiskManager';
import { analyzeIndicators } from './indicators';
import { getTradingJournalService } from './journalAlerts';
import { getMarketDataProvider } from './marketData';
import { evaluateStrategies } from './strategyEngine';
import { ExchangeCode, Timeframe } from './tradingTypes';

export function registerTradingCapabilities(registry: CapabilityRegistry): void {
  registry.register({
    id: 'trading.analyze_stock',
    name: 'trading_analyze_stock',
    description:
      'Analyze an NSE/BSE stock using deterministic indicators (VWAP, RSI14, MACD, EMA 9/20/50, ATR) and candidate intraday setups.',
    category: 'trading',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['trading:read'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        exchange: { type: 'string', enum: ['NSE', 'BSE'] },
        timeframe: { type: 'string', enum: ['5m', '15m', '1h'] },
      },
      required: ['symbol'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        dataQuality: { type: 'string' },
      },
      required: ['symbol', 'dataQuality'],
    },
    execute: async (args) => {
      const symbol = String(args.symbol || '').trim().toUpperCase();
      const exchange: ExchangeCode = args.exchange === 'BSE' ? 'BSE' : 'NSE';
      const timeframe: Timeframe =
        args.timeframe === '15m' || args.timeframe === '1h' ? args.timeframe : '5m';

      const series = await getMarketDataProvider().getCandles(exchange, symbol, timeframe);
      const evaluation = evaluateStrategies(series);
      return {
        verified: true,
        data: {
          symbol,
          exchange,
          timeframe,
          dataQuality: series.quality,
          stale: series.stale,
          suspended: evaluation.suspended,
          indicators: evaluation.indicators,
          candidates: evaluation.candidates,
          sourceName: series.sourceName,
          sourceType: series.quality === 'LIVE' ? 'live' : series.quality === 'DELAYED' ? 'delayed' : 'fixture',
          timestamp: series.exchangeTimestamp || series.receivedTimestamp,
          freshnessSeconds: series.freshnessSeconds,
        },
        message: evaluation.suspended
          ? `${exchange}:${symbol} (${timeframe}): ${evaluation.reason}`
          : `${exchange}:${symbol} (${timeframe}): ${evaluation.candidates.length} candidate setup(s) found. Data quality: ${series.quality}.`,
      };
    },
  });

  registry.register({
    id: 'trading.risk_budget',
    name: 'trading_risk_budget',
    description: 'Show current trading session capital, reserved capital, and remaining daily risk budget.',
    category: 'trading',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['trading:read'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { confirmed: { type: 'boolean' } },
      required: ['confirmed'],
    },
    execute: async (_args, ctx) => {
      const ownerId = ctx.actor || 'local';
      const mgr = getCapitalRiskManager();
      const [session, riskConfig] = await Promise.all([
        mgr.getSessionCapital(ownerId),
        mgr.getRiskConfig(ownerId),
      ]);
      if (!session) {
        return {
          verified: true,
          data: { confirmed: false, riskConfigured: Boolean(riskConfig) },
          message:
            'No trading session capital confirmed yet. Please confirm your available trading capital before sizing positions.',
        };
      }
      return {
        verified: true,
        data: {
          confirmed: true,
          riskConfigured: Boolean(riskConfig),
          allocatedCapital: formatMinorUnits(session.allocatedCapitalMinor),
          availableForNewPositions: formatMinorUnits(session.availableForNewPositionsMinor),
          remainingDailyRisk: formatMinorUnits(session.remainingDailyRiskMinor),
          realizedPnl: formatMinorUnits(session.realizedPnlMinor),
          currency: session.currency,
        },
        message: `Session capital: ${session.currency} ${formatMinorUnits(session.allocatedCapitalMinor)}, Remaining daily risk budget: ${session.currency} ${formatMinorUnits(session.remainingDailyRiskMinor)}.`,
      };
    },
  });

  registry.register({
    id: 'trading.position_size',
    name: 'trading_position_size',
    description:
      'Deterministically validate a setup against risk limits and calculate exact position size, charges, and slippage.',
    category: 'trading',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['trading:read'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        exchange: { type: 'string', enum: ['NSE', 'BSE'] },
        direction: { type: 'string', enum: ['LONG', 'SHORT'] },
        entryPrice: { type: ['number', 'string'] },
        stopLoss: { type: ['number', 'string'] },
        target: { type: ['number', 'string'] },
      },
      required: ['symbol', 'direction', 'entryPrice', 'stopLoss', 'target'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        approved: { type: 'boolean' },
        quantity: { type: 'number' },
      },
      required: ['approved', 'quantity'],
    },
    execute: async (args, ctx) => {
      const ownerId = ctx.actor || 'local';
      const symbol = String(args.symbol || '').trim().toUpperCase();
      const exchange: ExchangeCode = args.exchange === 'BSE' ? 'BSE' : 'NSE';
      const sizing = await getCapitalRiskManager().validateAndSizeCandidate(ownerId, {
        instrument: {
          exchange,
          symbol,
          name: symbol,
          instrumentType: 'CASH_EQUITY',
          sector: 'GENERAL',
          lotSize: 1,
          tickSizeMinor: 5,
        },
        direction: args.direction === 'SHORT' ? 'SHORT' : 'LONG',
        suggestedEntryMinor: toMinorUnits(args.entryPrice as number | string),
        stopLossMinor: toMinorUnits(args.stopLoss as number | string),
        targetMinor: toMinorUnits(args.target as number | string),
        dataQuality: 'HISTORICAL_FIXTURE',
      });
      return {
        verified: true,
        data: sizing,
        message: sizing.approved
          ? `Validated position size for ${exchange}:${symbol}: ${sizing.quantity} unit(s), risk ${sizing.currency} ${formatMinorUnits(sizing.riskAmountMinor)}, est. charges ${formatMinorUnits(sizing.estimatedChargesMinor)}, R:R ${sizing.rewardRiskRatio}.`
          : `Setup rejected: ${sizing.reasons.join(' ')}`,
      };
    },
  });

  registry.register({
    id: 'trading.journal_review',
    name: 'trading_journal_review',
    description: 'Review user-entered trading journal entries and realized P&L.',
    category: 'trading',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['trading:read'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { rows: { type: 'array' } },
      required: ['rows'],
    },
    execute: async (_args, ctx) => {
      const ownerId = ctx.actor || 'local';
      const entries = await getTradingJournalService().listJournal(ownerId, 50);
      return {
        verified: true,
        data: {
          rows: entries.map((e) => ({
            symbol: `${e.exchange}:${e.symbol}`,
            side: e.side,
            qty: e.quantity,
            entry: e.entryPriceFormatted,
            exit: e.exitPriceFormatted ?? 'OPEN',
            pnl: e.realizedPnlFormatted,
            status: e.status,
            source: e.sourceClassification,
          })),
        },
        message:
          entries.length === 0
            ? 'No trading journal entries recorded yet.'
            : `Found ${entries.length} trading journal entry(ies).`,
      };
    },
  });

  registry.register({
    id: 'trading.backtest',
    name: 'trading_backtest',
    description:
      'Run a deterministic historical backtest (no look-ahead bias, with transaction charges and slippage) on fixture or supplied candles.',
    category: 'trading',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['trading:read'],
    timeoutMs: 10_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        exchange: { type: 'string', enum: ['NSE', 'BSE'] },
        timeframe: { type: 'string', enum: ['5m', '15m', '1h'] },
        strategyId: { type: 'string' },
      },
      required: ['symbol', 'strategyId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        isHistoricalSimulation: { type: 'boolean' },
      },
      required: ['isHistoricalSimulation'],
    },
    execute: async (args, ctx) => {
      const ownerId = ctx.actor || 'local';
      const symbol = String(args.symbol || '').trim().toUpperCase();
      const exchange: ExchangeCode = args.exchange === 'BSE' ? 'BSE' : 'NSE';
      const timeframe: Timeframe =
        args.timeframe === '15m' || args.timeframe === '1h' ? args.timeframe : '5m';

      const series = await getMarketDataProvider().getCandles(exchange, symbol, timeframe);
      if (series.candles.length < 25) {
        return {
          verified: true,
          data: { isHistoricalSimulation: true, error: 'Insufficient historical candles (need >= 25)' },
          message: `Insufficient historical candles for ${exchange}:${symbol} (${series.candles.length} found).`,
        };
      }
      const res = await runBacktest({
        ownerId,
        instrument: series.instrument,
        timeframe,
        candles: series.candles,
        strategyId: String(args.strategyId),
      });
      return {
        verified: true,
        data: res,
        message: `Historical simulation (${res.strategyId} on ${symbol}): ${res.inSample.tradesCount} in-sample trades, win rate ${res.inSample.winRatePct}%, net P&L ${res.inSample.totalNetPnlFormatted}.`,
      };
    },
  });
}
