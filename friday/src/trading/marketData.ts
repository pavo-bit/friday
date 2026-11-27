// ============================================================
// FRIDAY — Provider-Independent Market Data Foundation
// Handles NSE/BSE metadata, candle deduplication, ordering,
// missing-candle detection, and freshness/staleness checks
// ============================================================

import {
  ExchangeCode,
  InstrumentMetadata,
  MarketDataQuality,
  MarketDataSeries,
  OhlcvCandle,
  Timeframe,
} from './tradingTypes';

export interface MarketDataProvider {
  readonly providerName: string;
  getInstrument(exchange: ExchangeCode, symbol: string): Promise<InstrumentMetadata | null>;
  getCandles(
    exchange: ExchangeCode,
    symbol: string,
    timeframe: Timeframe,
    options?: { maxStaleSeconds?: number }
  ): Promise<MarketDataSeries>;
}

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
};

/**
 * Normalize out-of-order candles, remove duplicate timestamps, detect gaps, and evaluate freshness.
 */
export function normalizeAndValidateCandles(params: {
  instrument: InstrumentMetadata;
  timeframe: Timeframe;
  sourceName: string;
  declaredQuality: MarketDataQuality;
  rawCandles: OhlcvCandle[];
  maxStaleSeconds?: number;
  nowMs?: number;
}): MarketDataSeries {
  const receivedTimestamp = new Date(params.nowMs ?? Date.now()).toISOString();
  const warnings: string[] = [];

  if (!params.rawCandles || params.rawCandles.length === 0) {
    return {
      instrument: params.instrument,
      timeframe: params.timeframe,
      sourceName: params.sourceName,
      quality: 'UNAVAILABLE',
      exchangeTimestamp: null,
      receivedTimestamp,
      freshnessSeconds: null,
      stale: true,
      missingCandlesDetected: 0,
      duplicatesRemoved: 0,
      candles: [],
      warnings: ['No candle data available from provider.'],
    };
  }

  // Deduplicate by timestamp (keep latest occurrence) and validate OHLCV
  const byTs = new Map<number, OhlcvCandle>();
  let duplicatesRemoved = 0;
  for (const c of params.rawCandles) {
    const ms = Date.parse(c.timestamp);
    if (Number.isNaN(ms)) continue;
    if (c.openMinor <= 0 || c.highMinor <= 0 || c.lowMinor <= 0 || c.closeMinor <= 0 || c.volume < 0) {
      continue;
    }
    if (byTs.has(ms)) {
      duplicatesRemoved++;
    }
    byTs.set(ms, { ...c, timestamp: new Date(ms).toISOString() });
  }

  const sortedEntries = Array.from(byTs.entries()).sort((a, b) => a[0] - b[0]);
  const candles = sortedEntries.map(([, c]) => c);
  const intervalMs = TIMEFRAME_MS[params.timeframe];

  let missingCandlesDetected = 0;
  for (let i = 1; i < sortedEntries.length; i++) {
    const gap = sortedEntries[i][0] - sortedEntries[i - 1][0];
    if (gap > intervalMs * 1.5) {
      missingCandlesDetected += Math.floor(gap / intervalMs) - 1;
    }
  }

  if (duplicatesRemoved > 0) {
    warnings.push(`Removed ${duplicatesRemoved} duplicate candle(s).`);
  }
  if (missingCandlesDetected > 0) {
    warnings.push(`Detected ${missingCandlesDetected} missing candle interval(s).`);
  }

  const lastMs = sortedEntries.length > 0 ? sortedEntries[sortedEntries.length - 1][0] : null;
  const exchangeTimestamp = lastMs !== null ? new Date(lastMs).toISOString() : null;
  const nowMs = params.nowMs ?? Date.now();
  const freshnessSeconds = lastMs !== null ? Math.max(0, Math.round((nowMs - lastMs) / 1000)) : null;

  const maxStaleSeconds = params.maxStaleSeconds ?? (intervalMs / 1000) * 2;
  let quality = params.declaredQuality;
  let stale = quality === 'STALE' || quality === 'UNAVAILABLE';

  if (
    (quality === 'LIVE' || quality === 'DELAYED') &&
    freshnessSeconds !== null &&
    freshnessSeconds > maxStaleSeconds
  ) {
    stale = true;
    quality = 'STALE';
    warnings.push(`Market data is stale (${freshnessSeconds}s old > ${maxStaleSeconds}s threshold).`);
  }

  if (quality === 'HISTORICAL_FIXTURE') {
    warnings.push('Historical fixture data — not live exchange pricing.');
  }

  return {
    instrument: params.instrument,
    timeframe: params.timeframe,
    sourceName: params.sourceName,
    quality,
    exchangeTimestamp,
    receivedTimestamp,
    freshnessSeconds,
    stale,
    missingCandlesDetected,
    duplicatesRemoved,
    candles,
    warnings,
  };
}

/**
 * Deterministic historical-fixture provider (never invents live prices).
 */
export class FixtureMarketDataProvider implements MarketDataProvider {
  readonly providerName = 'HistoricalFixtureProvider';
  private instruments = new Map<string, InstrumentMetadata>();
  private seriesMap = new Map<string, { quality: MarketDataQuality; candles: OhlcvCandle[] }>();

  registerFixture(
    instrument: InstrumentMetadata,
    timeframe: Timeframe,
    candles: OhlcvCandle[],
    quality: MarketDataQuality = 'HISTORICAL_FIXTURE'
  ): void {
    const instKey = `${instrument.exchange}:${instrument.symbol.toUpperCase()}`;
    this.instruments.set(instKey, instrument);
    this.seriesMap.set(`${instKey}:${timeframe}`, { quality, candles });
  }

  async getInstrument(exchange: ExchangeCode, symbol: string): Promise<InstrumentMetadata | null> {
    return this.instruments.get(`${exchange}:${symbol.toUpperCase()}`) || null;
  }

  async getCandles(
    exchange: ExchangeCode,
    symbol: string,
    timeframe: Timeframe,
    options?: { maxStaleSeconds?: number }
  ): Promise<MarketDataSeries> {
    const instKey = `${exchange}:${symbol.toUpperCase()}`;
    const instrument = this.instruments.get(instKey) || {
      exchange,
      symbol: symbol.toUpperCase(),
      name: symbol.toUpperCase(),
      instrumentType: 'CASH_EQUITY',
      sector: 'GENERAL',
      lotSize: 1,
      tickSizeMinor: 5,
    };
    const entry = this.seriesMap.get(`${instKey}:${timeframe}`);
    return normalizeAndValidateCandles({
      instrument,
      timeframe,
      sourceName: this.providerName,
      declaredQuality: entry?.quality || 'UNAVAILABLE',
      rawCandles: entry?.candles || [],
      maxStaleSeconds: options?.maxStaleSeconds,
    });
  }
}

let _marketDataProvider: FixtureMarketDataProvider | null = null;
export function getMarketDataProvider(): FixtureMarketDataProvider {
  if (!_marketDataProvider) {
    _marketDataProvider = new FixtureMarketDataProvider();
  }
  return _marketDataProvider;
}
