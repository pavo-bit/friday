// ============================================================
// FRIDAY — Trading Copilot Types (NSE/BSE Intraday Foundation)
// ============================================================

export type ExchangeCode = 'NSE' | 'BSE';
export type InstrumentType = 'CASH_EQUITY' | 'FNO';
export type Timeframe = '5m' | '15m' | '1h';
export type MarketDataQuality = 'LIVE' | 'DELAYED' | 'HISTORICAL_FIXTURE' | 'STALE' | 'UNAVAILABLE';
export type TradeDirection = 'LONG' | 'SHORT';

export type MarketSessionState =
  | 'PRE_OPEN'
  | 'REGULAR_OPEN'
  | 'POST_CLOSE'
  | 'CLOSED_WEEKEND'
  | 'CLOSED_HOLIDAY'
  | 'CLOSED_OVERNIGHT'
  | 'SPECIAL_SESSION';

export interface MarketSessionInfo {
  exchange: ExchangeCode;
  state: MarketSessionState;
  isOpenForTrading: boolean;
  isOpen?: boolean;
  isPreOpen: boolean;
  timezone: string;
  exchangeTimeFormatted: string;
  sessionStartIst: string;
  sessionEndIst: string;
  nextSessionOpenIso: string;
  nextSessionOpen?: string;
  holidayName?: string;
  holiday?: { name: string };
  isMuhuratTrading?: boolean;
  description: string;
}

export interface InstrumentMetadata {
  exchange: ExchangeCode;
  symbol: string;
  name: string;
  instrumentType: InstrumentType;
  sector: string;
  lotSize: number;
  tickSizeMinor: number;
}

export interface OhlcvCandle {
  timestamp: string; // ISO-8601 UTC/IST
  openMinor: number;
  highMinor: number;
  lowMinor: number;
  closeMinor: number;
  volume: number;
}

export interface MarketDataSeries {
  instrument: InstrumentMetadata;
  timeframe: Timeframe;
  sourceName: string;
  quality: MarketDataQuality;
  exchangeTimestamp: string | null;
  receivedTimestamp: string;
  freshnessSeconds: number | null;
  stale: boolean;
  missingCandlesDetected: number;
  duplicatesRemoved: number;
  candles: OhlcvCandle[];
  warnings: string[];
}

export interface IndicatorSnapshot {
  vwapMinor: number | null;
  rsi14: number | null;
  macd: { line: number; signal: number; histogram: number } | null;
  ema9Minor: number | null;
  ema20Minor: number | null;
  ema21Minor?: number | null;
  sma20Minor?: number | null;
  ema50Minor: number | null;
  atr14Minor: number | null;
  avgVolume20: number | null;
  supportMinor: number | null;
  resistanceMinor: number | null;
  openingRangeMinor: { highMinor: number; lowMinor: number } | null;
  openingRangeHighMinor?: number;
  openingRangeLowMinor?: number;
  volumeBreakoutRatio: number | null;
  trendStrength: 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH';
  warmupComplete: boolean;
  candleCount: number;
}

export interface TradeCandidate {
  candidateId: string;
  strategyId: string;
  strategyVersion: string;
  strategyName?: string;
  instrument: InstrumentMetadata;
  timeframe: Timeframe;
  direction: TradeDirection;
  entryConditions: string[];
  reasons?: string[];
  suggestedEntryMinor: number;
  stopLossMinor: number;
  targetMinor: number;
  rewardRiskRatio: number;
  riskRewardRatio?: number;
  targetMethodology: string;
  confidence: number;
  confidenceScore?: number;
  confidenceTier?: 'HIGH' | 'MEDIUM' | 'LOW';
  signalQualityExplanation: string;
  supportingIndicators: Record<string, unknown>;
  invalidationConditions: string[];
  invalidationCondition?: string;
  dataTimestamp: string;
  dataSource: string;
  dataQuality: MarketDataQuality;
  requiresRiskValidation: true;
}

export interface RiskConfigRecord {
  ownerId: string;
  maxRiskPerTradeBps: number; // e.g., 100 = 1.00%
  maxDailyLossBps: number; // e.g., 300 = 3.00%
  maxOpenPositions: number;
  maxCapitalAllocationBps: number; // e.g., 2500 = 25.00% per trade
  maxConcentrationBps: number; // e.g., 4000 = 40.00%
  maxConsecutiveLosses: number;
  minRewardRiskBps: number; // e.g., 15000 = 1.50 RR
  allowedExchanges: ExchangeCode[];
  allowedInstruments: InstrumentType[];
  sessionStartIst: string;
  sessionEndIst: string;
  updatedAt: string;
}

export interface TradingCapitalSession {
  id: string;
  ownerId: string;
  sessionDate: string;
  totalEquityMinor: number;
  availableCashMinor: number;
  allocatedCapitalMinor: number;
  reservedCapitalMinor: number;
  availableForNewPositionsMinor: number;
  realizedPnlMinor: number;
  unrealizedPnlMinor: number;
  dailyRiskBudgetMinor: number;
  remainingDailyRiskMinor: number;
  currency: string;
  confirmedByUser: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PositionSizingResult {
  approved: boolean;
  reasons: string[];
  quantity: number;
  recommendedQuantity?: number;
  positionValueMinor: number;
  riskAmountMinor: number;
  maxAllowedRiskMinor?: number;
  netProjectedPnlMinor?: number;
  estimatedChargesMinor: number;
  estimatedSlippageMinor: number;
  rewardRiskRatio: number;
  maxLossWithCostsMinor: number;
  currency: string;
}
