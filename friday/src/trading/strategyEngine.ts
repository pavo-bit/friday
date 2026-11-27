// ============================================================
// FRIDAY — Extensible Intraday Strategy Engine
// Evaluates deterministic candidates; NEVER bypasses RiskManager
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { analyzeIndicators } from './indicators';
import { IndicatorSnapshot, InstrumentMetadata, MarketDataSeries, Timeframe, TradeCandidate } from './tradingTypes';
import { MarketDataRegistry, getMarketDataRegistry } from './marketData';

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
  targetMethodology: string;
  confidence: number;
  signalQualityExplanation: string;
  supportingIndicators: Record<string, unknown>;
  invalidationConditions: string[];
}): TradeCandidate | null {
  const risk = Math.abs(params.suggestedEntryMinor - params.stopLossMinor);
  const reward = Math.abs(params.targetMinor - params.suggestedEntryMinor);
  if (risk <= 0 || reward <= 0) return null;
  const rr = Math.round((reward / risk) * 100) / 100;

  const confVal = Math.max(0.1, Math.min(1.0, Math.round(params.confidence * 100) / 100));
  const confTier: 'HIGH' | 'MEDIUM' | 'LOW' =
    confVal >= 0.8 ? 'HIGH' : confVal >= 0.65 ? 'MEDIUM' : 'LOW';

  return {
    candidateId: uuidv4(),
    strategyId: params.strategyId,
    strategyVersion: params.strategyVersion,
    strategyName: params.strategyId.replace(/_/g, ' ').replace(/-/g, ' ').toUpperCase(),
    instrument: params.series.instrument,
    timeframe: params.series.timeframe,
    direction: params.direction,
    entryConditions: params.entryConditions,
    reasons: params.entryConditions,
    suggestedEntryMinor: Math.trunc(params.suggestedEntryMinor),
    stopLossMinor: Math.trunc(params.stopLossMinor),
    targetMinor: Math.trunc(params.targetMinor),
    rewardRiskRatio: rr,
    riskRewardRatio: rr,
    targetMethodology: params.targetMethodology,
    confidence: confVal,
    confidenceScore: confVal,
    confidenceTier: confTier,
    signalQualityExplanation: params.signalQualityExplanation,
    supportingIndicators: params.supportingIndicators,
    invalidationConditions: params.invalidationConditions,
    invalidationCondition: params.invalidationConditions.join('; '),
    dataTimestamp: params.series.exchangeTimestamp || params.series.receivedTimestamp,
    dataSource: params.series.sourceName,
    dataQuality: params.series.quality,
    requiresRiskValidation: true,
  };
}

export const VwapTrendContinuationStrategy: TradingStrategy = {
  id: 'vwap_trend_continuation',
  version: '1.1.0',
  evaluate(series, ind) {
    const last = series.candles[series.candles.length - 1];
    if (!last || ind.vwapMinor === null || ind.ema20Minor === null || ind.atr14Minor === null) return null;

    if (
      last.closeMinor > ind.vwapMinor &&
      last.closeMinor > ind.ema20Minor &&
      (ind.rsi14 ?? 50) >= 52 &&
      (ind.rsi14 ?? 50) <= 72
    ) {
      const risk = Math.max(ind.atr14Minor, Math.round(last.closeMinor * 0.005));
      const stopLoss = Math.min(last.closeMinor - risk, ind.vwapMinor - Math.round(risk * 0.25));
      const actualRisk = last.closeMinor - stopLoss;
      const target = last.closeMinor + Math.round(actualRisk * 2.0);
      const confidence = (ind.rsi14 ?? 50) >= 58 && ind.trendStrength.includes('BULLISH') ? 0.88 : 0.76;

      return buildCandidate({
        strategyId: this.id,
        strategyVersion: this.version,
        series,
        direction: 'LONG',
        entryConditions: ['Close above VWAP', 'Close above EMA20', 'RSI14 in 52-72 momentum band'],
        suggestedEntryMinor: last.closeMinor,
        stopLossMinor: stopLoss,
        targetMinor: target,
        targetMethodology: '2.0x ATR projection above entry',
        confidence,
        signalQualityExplanation: `Price holds above session VWAP and EMA20 with RSI at ${ind.rsi14} in the momentum continuation band.`,
        supportingIndicators: { vwapMinor: ind.vwapMinor, ema20Minor: ind.ema20Minor, rsi14: ind.rsi14 },
        invalidationConditions: ['Candle close below VWAP', 'RSI14 drops below 45'],
      });
    }
    return null;
  },
};

export const EmaAlignmentStrategy: TradingStrategy = {
  id: 'ema_alignment',
  version: '1.1.0',
  evaluate(series, ind) {
    const last = series.candles[series.candles.length - 1];
    if (!last || ind.ema9Minor === null || ind.ema20Minor === null || ind.ema50Minor === null || ind.atr14Minor === null) {
      return null;
    }

    if (ind.ema9Minor > ind.ema20Minor && ind.ema20Minor > ind.ema50Minor && last.closeMinor >= ind.ema9Minor) {
      const risk = Math.max(ind.atr14Minor, last.closeMinor - ind.ema20Minor);
      const confidence = ind.trendStrength === 'STRONG_BULLISH' ? 0.85 : 0.72;

      return buildCandidate({
        strategyId: this.id,
        strategyVersion: this.version,
        series,
        direction: 'LONG',
        entryConditions: ['EMA9 > EMA20 > EMA50 bullish alignment', 'Price holding above EMA9'],
        suggestedEntryMinor: last.closeMinor,
        stopLossMinor: last.closeMinor - risk,
        targetMinor: last.closeMinor + risk * 2,
        targetMethodology: '2.0x ATR extension above EMA9 pull-in',
        confidence,
        signalQualityExplanation: `Moving averages show full bullish stack (9 > 20 > 50) with price holding above EMA9.`,
        supportingIndicators: { ema9Minor: ind.ema9Minor, ema20Minor: ind.ema20Minor, ema50Minor: ind.ema50Minor },
        invalidationConditions: ['EMA9 crosses below EMA20', 'Close below EMA50'],
      });
    }
    return null;
  },
};

export const VolumeBreakoutStrategy: TradingStrategy = {
  id: 'volume_breakout',
  version: '1.1.0',
  evaluate(series, ind) {
    if (series.candles.length < 21 || ind.avgVolume20 === null || ind.atr14Minor === null) return null;
    const last = series.candles[series.candles.length - 1];
    const prior = series.candles.slice(-21, -1);
    const priorHigh = Math.max(...prior.map((c) => c.highMinor));

    if (last.closeMinor > priorHigh && last.volume >= ind.avgVolume20 * 1.5) {
      const risk = Math.max(ind.atr14Minor, Math.round(last.closeMinor * 0.006));
      const volRatio = ind.volumeBreakoutRatio ?? Math.round((last.volume / ind.avgVolume20) * 100) / 100;
      const confidence = volRatio >= 2.0 ? 0.9 : 0.78;

      return buildCandidate({
        strategyId: this.id,
        strategyVersion: this.version,
        series,
        direction: 'LONG',
        entryConditions: ['Close above 20-bar high', `Volume ${volRatio}x >= 1.5x 20-bar average`],
        suggestedEntryMinor: last.closeMinor,
        stopLossMinor: last.closeMinor - risk,
        targetMinor: last.closeMinor + risk * 2,
        targetMethodology: '2.0x ATR breakout expansion',
        confidence,
        signalQualityExplanation: `Breakout above 20-candle high confirmed with ${volRatio}x relative volume spike.`,
        supportingIndicators: { priorHigh, volume: last.volume, avgVolume20: ind.avgVolume20, volRatio },
        invalidationConditions: ['Price falls back below breakout level', 'Volume fades on continuation'],
      });
    }
    return null;
  },
};

export const SupportResistanceRejectionStrategy: TradingStrategy = {
  id: 'sr_rejection',
  version: '1.1.0',
  evaluate(series, ind) {
    const last = series.candles[series.candles.length - 1];
    if (!last || ind.supportMinor === null || ind.resistanceMinor === null || ind.atr14Minor === null) return null;
    const nearSupport = last.lowMinor <= ind.supportMinor + Math.round(ind.atr14Minor * 0.3);

    if (nearSupport && last.closeMinor > last.openMinor) {
      const risk = Math.max(ind.atr14Minor, last.closeMinor - ind.supportMinor + 100);
      const target = Math.max(last.closeMinor + risk * 2, ind.resistanceMinor);

      return buildCandidate({
        strategyId: this.id,
        strategyVersion: this.version,
        series,
        direction: 'LONG',
        entryConditions: ['Bullish rejection candle near 20-bar support'],
        suggestedEntryMinor: last.closeMinor,
        stopLossMinor: last.closeMinor - risk,
        targetMinor: target,
        targetMethodology: 'Prior swing resistance level',
        confidence: 0.74,
        signalQualityExplanation: `Candle tested support at ${ind.supportMinor / 100} and formed a bullish hammer/rejection close.`,
        supportingIndicators: { supportMinor: ind.supportMinor, resistanceMinor: ind.resistanceMinor },
        invalidationConditions: ['Candle close below support level'],
      });
    }
    return null;
  },
};

export const OpeningRangeBreakoutStrategy: TradingStrategy = {
  id: 'opening_range_breakout',
  version: '1.1.0',
  evaluate(series, ind) {
    if (series.candles.length < 4 || ind.atr14Minor === null) return null;
    const or = ind.openingRangeMinor;
    if (!or) return null;

    const last = series.candles[series.candles.length - 1];
    if (last.closeMinor > or.highMinor) {
      const orWidth = or.highMinor - or.lowMinor;
      const risk = Math.max(ind.atr14Minor, Math.round(orWidth * 0.5));
      const target = last.closeMinor + Math.max(risk * 2, orWidth);

      return buildCandidate({
        strategyId: this.id,
        strategyVersion: this.version,
        series,
        direction: 'LONG',
        entryConditions: ['Close above 15m opening range high (ORB)'],
        suggestedEntryMinor: last.closeMinor,
        stopLossMinor: last.closeMinor - risk,
        targetMinor: target,
        targetMethodology: '1.0x Opening Range width extension',
        confidence: 0.82,
        signalQualityExplanation: `Breakout candle closed cleanly above the opening 15-minute range high (${or.highMinor / 100}).`,
        supportingIndicators: { openingRangeHigh: or.highMinor, openingRangeLow: or.lowMinor },
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
  snapshot: IndicatorSnapshot;
  candidates: TradeCandidate[];
} {
  const indicators = analyzeIndicators(series.candles);
  if (series.stale || series.quality === 'UNAVAILABLE' || series.candles.length === 0) {
    return {
      suspended: true,
      reason: `Market data is ${series.quality}; live setup evaluation suspended.`,
      indicators,
      snapshot: indicators,
      candidates: [],
    };
  }

  const candidates: TradeCandidate[] = [];
  for (const strat of strategies) {
    const c = strat.evaluate(series, indicators);
    if (c) candidates.push(c);
  }

  return { suspended: false, indicators, snapshot: indicators, candidates };
}

/**
 * Multi-Symbol Scanner: evaluates setups across a list of instruments and ranks them by confidence and R:R.
 */
export async function scanMultipleInstruments(
  instruments: InstrumentMetadata[],
  registry: MarketDataRegistry = getMarketDataRegistry(),
  timeframe: Timeframe = '5m'
): Promise<{
  scannedCount: number;
  totalInstrumentsScanned: number;
  candidates: TradeCandidate[];
  setups: TradeCandidate[];
}> {
  const allCandidates: TradeCandidate[] = [];

  for (const inst of instruments) {
    try {
      const series = await registry.getCandles(inst.exchange, inst.symbol, timeframe);
      const evalRes = evaluateStrategies(series);
      allCandidates.push(...evalRes.candidates);
    } catch {
      // Ignore scan failure for single instrument
    }
  }

  // Sort descending by confidence then rewardRiskRatio
  allCandidates.sort(
    (a, b) =>
      (b.confidenceScore ?? b.confidence) - (a.confidenceScore ?? a.confidence) ||
      b.rewardRiskRatio - a.rewardRiskRatio
  );

  return {
    scannedCount: instruments.length,
    totalInstrumentsScanned: instruments.length,
    candidates: allCandidates,
    setups: allCandidates,
  };
}
