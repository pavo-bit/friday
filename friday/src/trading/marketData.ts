// ============================================================
// FRIDAY — Provider-Independent Market Data Foundation
// Handles NSE/BSE metadata, candle deduplication, ordering,
// sanity validation, missing-candle detection & freshness checks
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

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
};

/**
 * Standard NSE/BSE instruments supported out-of-the-box.
 */
export const STANDARD_INSTRUMENTS: Record<string, InstrumentMetadata> = {
  'NSE:NIFTY': {
    exchange: 'NSE',
    symbol: 'NIFTY',
    name: 'NIFTY 50 Index',
    instrumentType: 'FNO',
    sector: 'INDEX',
    lotSize: 25,
    tickSizeMinor: 5,
  },
  'NSE:BANKNIFTY': {
    exchange: 'NSE',
    symbol: 'BANKNIFTY',
    name: 'NIFTY Bank Index',
    instrumentType: 'FNO',
    sector: 'BANKING',
    lotSize: 15,
    tickSizeMinor: 5,
  },
  'NSE:RELIANCE': {
    exchange: 'NSE',
    symbol: 'RELIANCE',
    name: 'Reliance Industries Ltd',
    instrumentType: 'CASH_EQUITY',
    sector: 'ENERGY',
    lotSize: 1,
    tickSizeMinor: 5,
  },
  'NSE:HDFCBANK': {
    exchange: 'NSE',
    symbol: 'HDFCBANK',
    name: 'HDFC Bank Ltd',
    instrumentType: 'CASH_EQUITY',
    sector: 'BANKING',
    lotSize: 1,
    tickSizeMinor: 5,
  },
  'NSE:TCS': {
    exchange: 'NSE',
    symbol: 'TCS',
    name: 'Tata Consultancy Services Ltd',
    instrumentType: 'CASH_EQUITY',
    sector: 'IT',
    lotSize: 1,
    tickSizeMinor: 5,
  },
  'NSE:INFY': {
    exchange: 'NSE',
    symbol: 'INFY',
    name: 'Infosys Ltd',
    instrumentType: 'CASH_EQUITY',
    sector: 'IT',
    lotSize: 1,
    tickSizeMinor: 5,
  },
  'BSE:SENSEX': {
    exchange: 'BSE',
    symbol: 'SENSEX',
    name: 'BSE SENSEX Index',
    instrumentType: 'FNO',
    sector: 'INDEX',
    lotSize: 10,
    tickSizeMinor: 5,
  },
};

// Aliases for convenient symbol lookups
STANDARD_INSTRUMENTS.NIFTY = STANDARD_INSTRUMENTS['NSE:NIFTY'];
STANDARD_INSTRUMENTS.BANKNIFTY = STANDARD_INSTRUMENTS['NSE:BANKNIFTY'];
STANDARD_INSTRUMENTS.RELIANCE = STANDARD_INSTRUMENTS['NSE:RELIANCE'];
STANDARD_INSTRUMENTS.HDFCBANK = STANDARD_INSTRUMENTS['NSE:HDFCBANK'];
STANDARD_INSTRUMENTS.TCS = STANDARD_INSTRUMENTS['NSE:TCS'];
STANDARD_INSTRUMENTS.INFY = STANDARD_INSTRUMENTS['NSE:INFY'];
STANDARD_INSTRUMENTS.SENSEX = STANDARD_INSTRUMENTS['BSE:SENSEX'];

/**
 * Normalize out-of-order candles, remove duplicate timestamps, validate OHLC sanity,
 * detect interval gaps, and evaluate freshness/staleness.
 */
export function normalizeAndValidateCandles(params: {
  instrument: InstrumentMetadata;
  timeframe: Timeframe;
  sourceName: string;
  declaredQuality: MarketDataQuality;
  rawCandles: OhlcvCandle[];
  maxStaleSeconds?: number;
  nowMs?: number;
  strict?: boolean;
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

  // Deduplicate by timestamp, filter corrupt OHLC bars (high < low, negative prices, etc.)
  const byTs = new Map<number, OhlcvCandle>();
  let duplicatesRemoved = 0;
  let invalidPricesFiltered = 0;

  for (const c of params.rawCandles) {
    const ms = Date.parse(c.timestamp);
    if (Number.isNaN(ms)) continue;

    // Sanity checks: positive prices, high >= low, high >= open & close, low <= open & close
    const isCorrupt =
      c.openMinor <= 0 ||
      c.highMinor <= 0 ||
      c.lowMinor <= 0 ||
      c.closeMinor <= 0 ||
      c.volume < 0 ||
      c.highMinor < c.lowMinor ||
      c.highMinor < Math.max(c.openMinor, c.closeMinor) ||
      c.lowMinor > Math.min(c.openMinor, c.closeMinor);

    if (isCorrupt) {
      if (params.strict) {
        throw new Error(`OHLC integrity failure: corrupt candle at ${c.timestamp}`);
      }
      invalidPricesFiltered++;
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
  if (invalidPricesFiltered > 0) {
    warnings.push(`Filtered ${invalidPricesFiltered} corrupt/invalid price candle(s).`);
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
 * Generates synthetic realistic intraday trending/ranging candles for Indian fixtures.
 */
export function generateSyntheticIntradayCandles(
  ...args: any[]
): any {
  if (typeof args[0] === 'object' && args[0] !== null && 'symbol' in args[0]) {
    const instrument = args[0] as InstrumentMetadata;
    const timeframe: Timeframe =
      typeof args[1] === 'string' && (args[1] === '5m' || args[1] === '15m' || args[1] === '1h')
        ? (args[1] as Timeframe)
        : '5m';
    const basePriceMinor = typeof args[3] === 'number' ? args[3] : 250000;
    const trendParam = String(args[4] || 'UP').toUpperCase();
    const trend =
      trendParam.includes('BULL') || trendParam === 'UP'
        ? 'UP'
        : trendParam.includes('BEAR') || trendParam === 'DOWN'
        ? 'DOWN'
        : 'SIDEWAYS';
    const candles = generateSyntheticIntradayCandles(basePriceMinor, 75, timeframe, trend) as OhlcvCandle[];
    return {
      instrument,
      timeframe,
      sourceName: 'SyntheticFixture',
      quality: 'HISTORICAL_FIXTURE',
      dataQuality: 'HISTORICAL_FIXTURE',
      exchangeTimestamp: candles[candles.length - 1]?.timestamp || new Date().toISOString(),
      receivedTimestamp: new Date().toISOString(),
      freshnessSeconds: 0,
      stale: false,
      missingCandlesDetected: 0,
      duplicatesRemoved: 0,
      candles,
      warnings: [],
    };
  }

  const [basePriceMinor, count = 75, timeframe = '5m', trend = 'UP'] = args;
  const candles: OhlcvCandle[] = [];
  const intervalMs = TIMEFRAME_MS[timeframe as Timeframe] || 300000;
  // 09:15 IST anchor = today at 03:45 UTC
  const now = new Date();
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 45, 0, 0);

  let curPrice = basePriceMinor;
  for (let i = 0; i < count; i++) {
    const timestamp = new Date(startMs + i * intervalMs).toISOString();
    const drift = trend === 'UP' ? 0.0008 : trend === 'DOWN' ? -0.0008 : 0;
    const change = Math.round(curPrice * (drift + (Math.sin(i / 3) * 0.002)));
    const open = curPrice;
    const close = Math.max(100, open + change);
    const high = Math.round(Math.max(open, close) + Math.abs(change) * 0.6 + curPrice * 0.001);
    const low = Math.round(Math.min(open, close) - Math.abs(change) * 0.6 - curPrice * 0.001);
    const volume = Math.round(10000 + Math.abs(Math.sin(i / 2)) * 50000 + (i > count - 5 ? 80000 : 0));

    candles.push({
      timestamp,
      openMinor: open,
      highMinor: Math.max(high, open, close),
      lowMinor: Math.min(low, open, close),
      closeMinor: close,
      volume,
    });
    curPrice = close;
  }

  return candles;
}

/**
 * Deterministic historical-fixture provider (never invents live prices).
 */
export class FixtureMarketDataProvider implements MarketDataProvider {
  readonly providerName = 'HistoricalFixtureProvider';
  private instruments = new Map<string, InstrumentMetadata>();
  private seriesMap = new Map<string, { quality: MarketDataQuality; candles: OhlcvCandle[] }>();

  constructor() {
    this.seedStandardInstruments();
  }

  private seedStandardInstruments(): void {
    // Populate standard NSE/BSE metadata
    for (const [key, meta] of Object.entries(STANDARD_INSTRUMENTS)) {
      this.instruments.set(key, meta);
    }

    // Seed realistic fixture candles
    // NIFTY: ~24,500 (2,450,000 minor)
    this.registerFixture(
      STANDARD_INSTRUMENTS['NSE:NIFTY'],
      '5m',
      generateSyntheticIntradayCandles(2450000, 75, '5m', 'UP'),
      'HISTORICAL_FIXTURE'
    );
    // BANKNIFTY: ~52,000 (5,200,000 minor)
    this.registerFixture(
      STANDARD_INSTRUMENTS['NSE:BANKNIFTY'],
      '5m',
      generateSyntheticIntradayCandles(5200000, 75, '5m', 'UP'),
      'HISTORICAL_FIXTURE'
    );
    // RELIANCE: ~3,000 (300,000 minor)
    this.registerFixture(
      STANDARD_INSTRUMENTS['NSE:RELIANCE'],
      '5m',
      generateSyntheticIntradayCandles(300000, 75, '5m', 'UP'),
      'HISTORICAL_FIXTURE'
    );
    // HDFCBANK: ~1,700 (170,000 minor)
    this.registerFixture(
      STANDARD_INSTRUMENTS['NSE:HDFCBANK'],
      '5m',
      generateSyntheticIntradayCandles(170000, 75, '5m', 'SIDEWAYS'),
      'HISTORICAL_FIXTURE'
    );
  }

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
    const instKey = `${exchange}:${symbol.toUpperCase()}`;
    return this.instruments.get(instKey) || STANDARD_INSTRUMENTS[instKey] || null;
  }

  async getCandles(
    exchange: ExchangeCode,
    symbol: string,
    timeframe: Timeframe,
    options?: { maxStaleSeconds?: number }
  ): Promise<MarketDataSeries> {
    const instKey = `${exchange}:${symbol.toUpperCase()}`;
    let instrument = this.instruments.get(instKey) || STANDARD_INSTRUMENTS[instKey];

    if (!instrument) {
      instrument = {
        exchange,
        symbol: symbol.toUpperCase(),
        name: symbol.toUpperCase(),
        instrumentType: 'CASH_EQUITY',
        sector: 'GENERAL',
        lotSize: 1,
        tickSizeMinor: 5,
      };
    }

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

/**
 * Multi-Provider Registry with graceful fallback.
 */
export class MarketDataRegistry {
  private providers: MarketDataProvider[] = [];
  private defaultProvider: MarketDataProvider;

  constructor() {
    this.defaultProvider = new FixtureMarketDataProvider();
    this.providers.push(this.defaultProvider);
  }

  registerProvider(provider: MarketDataProvider, isDefault = false): void {
    this.providers.unshift(provider);
    if (isDefault) {
      this.defaultProvider = provider;
    }
  }

  getDefaultProvider(): MarketDataProvider {
    return this.defaultProvider;
  }

  async getInstrument(exchange: ExchangeCode, symbol: string): Promise<InstrumentMetadata | null> {
    for (const p of this.providers) {
      try {
        const inst = await p.getInstrument(exchange, symbol);
        if (inst) return inst;
      } catch {
        // Fallback to next provider
      }
    }
    return STANDARD_INSTRUMENTS[`${exchange}:${symbol.toUpperCase()}`] || null;
  }

  async getCandles(
    exchange: ExchangeCode,
    symbol: string,
    timeframe: Timeframe,
    options?: { maxStaleSeconds?: number }
  ): Promise<MarketDataSeries> {
    for (const p of this.providers) {
      try {
        const series = await p.getCandles(exchange, symbol, timeframe, options);
        if (series && series.candles.length > 0) {
          return series;
        }
      } catch {
        // Try fallback provider
      }
    }

    // Default fallback
    return this.defaultProvider.getCandles(exchange, symbol, timeframe, options);
  }
}

let _marketDataRegistry: MarketDataRegistry | null = null;

export function getMarketDataRegistry(): MarketDataRegistry {
  if (!_marketDataRegistry) {
    _marketDataRegistry = new MarketDataRegistry();
  }
  return _marketDataRegistry;
}

export function getMarketDataProvider(): MarketDataProvider {
  return getMarketDataRegistry().getDefaultProvider();
}
