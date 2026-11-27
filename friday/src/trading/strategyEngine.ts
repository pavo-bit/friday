// ============================================================
// FRIDAY — Extensible Intraday Strategy Engine
// Evaluates deterministic candidates; NEVER bypasses RiskManager
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { analyzeIndicators } from './indicators';
import { IndicatorSnapshot, MarketDataSeries, TradeCandidate } from './tradingTypes';

export interface TradingStrategy {
  readonly id: string;
  readonly version: string;
  evaluate(series: MarketDataSeries, indicators: IndicatorSnapshot): TradeCandidate | null;
}

function buildCandidate(params: {
  strategyId: string;
  strategyVersion: string;
  series: MarketDataSeries;
  direction: 'LONG' | 'SHORT';
  entryConditions: string[];
  suggestedEntryMinor: number;
  stopLossMinor: number;
  targetMinor: number;
  supportingIndicators: Record<string, unknown>;
  invalidationConditions: string[];
}): TradeCandidate | null {
  const risk = Math.abs(params.suggestedEntryMinor - params.stopLossMinor);
  const reward = Math.abs(params.targetMinor - params.suggestedEntryMinor);
  if (risk <= 0 || reward <= 0) return null;
  const rr = Math.round((reward / risk) * 100) / 100;

  return {
    candidateId: uuidv4(),
    strategyId: params.strategyId,
    strategyVersion: params.strategyVersion,
    instrument: params.series.instrument,
    timeframe: params.series.timeframe,
    direction: params.direction,
    entryConditions: params.entryConditions,
    suggestedEntryMinor: Math.trunc(params.suggestedEntryMinor),
    stopLossMinor: Math.trunc(params.stopLossMinor),
    targetMinor: Math.trunc(params.targetMinor),
    rewardRiskRatio: rr,
    supportingIndicators: params.supportingIndicators,
    invalidationConditions: params.invalidationConditions,
    dataTimestamp: params.series.exchangeTimestamp || params.series.receivedTimestamp,
    dataSource: params.series.sourceName,
    dataQuality: params.series.quality,
    requiresRiskValidation: true,
  };
}

export const VwapTrendContinuationStrategy: TradingStrategy = {
  id: 'vwap_trend_continuation',
  version: '1.0.0',
  evaluate(series, ind) {
    const last = series.candles[series.candles.length - 1];
    if (!last || ind.vwapMinor === null || ind.ema20Minor === null || ind.atr14Minor === null) return null;
    if (last.closeMinor > ind.vwapMinor && last.closeMinor > ind.ema20Minor && (ind.rsi14 ?? 50) >= 52 && (ind.rsi14 ?? 50) <= 72) {
      const risk = Math.max(ind.atr14Minor, Math.round(last.closeMinor * 0.005));
      return buildCandidate({
        strategyId: this.id,
        strategyVersion: this.version,
        series,
        direction: 'LONG',
        entryConditions: ['Close above VWAP', 'Close above EMA20', 'RSI14 in 52-72 momentum band'],
        suggestedEntryMinor: last.closeMinor,
        stopLossMinor: Math.min(last.closeMinor - risk, ind.vwapMinor - Math.round(risk * 0.25)),
        targetMinor: last.closeMinor + risk * 2,
        supportingIndicators: { vwapMinor: ind.vwapMinor, ema20Minor: ind.ema20Minor, rsi14: ind.rsi14 },
        invalidationConditions: ['Candle close below VWAP', 'RSI14 drops below 45'],
      });
    }
    return null;
  },
};

export const EmaAlignmentStrategy: TradingStrategy = {
  id: 'ema_alignment',
  version: '1.0.0',
  evaluate(series, ind) {
    const last = series.candles[series.candles.length - 1];
    if (!last || ind.ema9Minor === null || ind.ema20Minor === null || ind.ema50Minor === null || ind.atr14Minor === null) {
      return null;
    }
    if (ind.ema9Minor > ind.ema20Minor && ind.ema20Minor > ind.ema50Minor && last.closeMinor >= ind.ema9Minor) {
      const risk = Math.max(ind.atr14Minor, last.closeMinor - ind.ema20Minor);
      return buildCandidate({
        strategyId: this.id,
        strategyVersion: this.version,
        series,
        direction: 'LONG',
        entryConditions: ['EMA9 > EMA20 > EMA50 bullish alignment', 'Price holding above EMA9'],
        suggestedEntryMinor: last.closeMinor,
        stopLossMinor: last.closeMinor - risk,
        targetMinor: last.closeMinor + risk * 2,
        supportingIndicators: { ema9Minor: ind.ema9Minor, ema20Minor: ind.ema20Minor, ema50Minor: ind.ema50Minor },
        invalidationConditions: ['EMA9 crosses below EMA20'],
      });
    }
    return null;
  },
};

export const VolumeBreakoutStrategy: TradingStrategy = {
  id: 'volume_breakout',
  version: '1.0.0',
  evaluate(series, ind) {
    if (series.candles.length < 21 || ind.avgVolume20 === null || ind.atr14Minor === null) return null;
    const last = series.candles[series.candles.length - 1];
    const prior = series.candles.slice(-21, -1);
    const priorHigh = Math.max(...prior.map((c) => c.highMinor));
    if (last.closeMinor > priorHigh && last.volume >= ind.avgVolume20 * 1.5) {
      const risk = Math.max(ind.atr14Minor, Math.round(last.closeMinor * 0.006));
      return buildCandidate({
        strategyId: this.id,
        strategyVersion: this.version,
        series,
        direction: 'LONG',
        entryConditions: ['Close above 20-bar high', 'Volume >= 1.5x 20-bar average'],
        suggestedEntryMinor: last.closeMinor,
        stopLossMinor: last.closeMinor - risk,
        targetMinor: last.closeMinor + risk * 2,
        supportingIndicators: { priorHigh, volume: last.volume, avgVolume20: ind.avgVolume20 },
        invalidationConditions: ['Price falls back below breakout level'],
      });
    }
    return null;
  },
};

export const SupportResistanceRejectionStrategy: TradingStrategy = {
  id: 'sr_rejection',
  version: '1.0.0',
  evaluate(series, ind) {
    const last = series.candles[series.candles.length - 1];
    if (!last || ind.supportMinor === null || ind.resistanceMinor === null || ind.atr14Minor === null) return null;
    const nearSupport = last.lowMinor <= ind.supportMinor + Math.round(ind.atr14Minor * 0.3);
    if (nearSupport && last.closeMinor > last.openMinor) {
      const risk = Math.max(ind.atr14Minor, last.closeMinor - ind.supportMinor + 100);
      return buildCandidate({
        strategyId: this.id,
        strategyVersion: this.version,
        series,
        direction: 'LONG',
        entryConditions: ['Bullish rejection candle near 20-bar support'],
        suggestedEntryMinor: last.closeMinor,
        stopLossMinor: last.closeMinor - risk,
        targetMinor: Math.max(last.closeMinor + risk * 2, ind.resistanceMinor),
        supportingIndicators: { supportMinor: ind.supportMinor, resistanceMinor: ind.resistanceMinor },
        invalidationConditions: ['Candle close below support level'],
      });
    }
    return null;
  },
};

export const OpeningRangeBreakoutStrategy: TradingStrategy = {
  id: 'opening_range_breakout',
  version: '1.0.0',
  evaluate(series, ind) {
    if (series.candles.length < 4 || ind.atr14Minor === null) return null;
    const openingRange = series.candles.slice(0, 3);
    const orHigh = Math.max(...openingRange.map((c) => c.highMinor));
    const last = series.candles[series.candles.length - 1];
    if (last.closeMinor > orHigh) {
      const risk = Math.max(ind.atr14Minor, Math.round((orHigh - Math.min(...openingRange.map((c) => c.lowMinor))) * 0.5));
      return buildCandidate({
        strategyId: this.id,
        strategyVersion: this.version,
        series,
        direction: 'LONG',
        entryConditions: ['Close above 3-bar opening range high'],
        suggestedEntryMinor: last.closeMinor,
        stopLossMinor: last.closeMinor - risk,
        targetMinor: last.closeMinor + risk * 2,
        supportingIndicators: { openingRangeHigh: orHigh },
        invalidationConditions: ['Close back inside opening range'],
      });
    }
    return null;
  },
};

export const BUILTIN_STRATEGIES: TradingStrategy[] = [
  VwapTrendContinuationStrategy,
  EmaAlignmentStrategy,
  VolumeBreakoutStrategy,
  SupportResistanceRejectionStrategy,
  OpeningRangeBreakoutStrategy,
];

export function evaluateStrategies(
  series: MarketDataSeries,
  strategies: TradingStrategy[] = BUILTIN_STRATEGIES
): {
  suspended: boolean;
  reason?: string;
  indicators: IndicatorSnapshot;
  candidates: TradeCandidate[];
} {
  const indicators = analyzeIndicators(series.candles);
  if (series.stale || series.quality === 'UNAVAILABLE' || series.candles.length === 0) {
    return {
      suspended: true,
      reason: `Market data is ${series.quality}; live setup evaluation suspended.`,
      indicators,
      candidates: [],
    };
  }

  const candidates: TradeCandidate[] = [];
  for (const strat of strategies) {
    const c = strat.evaluate(series, indicators);
    if (c) candidates.push(c);
  }

  return { suspended: false, indicators, candidates };
}
