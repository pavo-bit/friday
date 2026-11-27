// ============================================================
// FRIDAY — Deterministic Technical Indicators
// VWAP, RSI(14), MACD(12,26,9), EMA(9,20,50), ATR(14),
// Average Volume(20), Support/Resistance, Opening Range & Trend
// ============================================================

import { IndicatorSnapshot, OhlcvCandle } from './tradingTypes';

export function computeEMA(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  let ema = sum / period;
  out[period - 1] = ema;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

export function computeMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): { line: number; signal: number; histogram: number } | null {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = computeEMA(closes, fast);
  const emaSlow = computeEMA(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      macdLine.push(emaFast[i]! - emaSlow[i]!);
    }
  }
  if (macdLine.length < signalPeriod) return null;
  const signalArr = computeEMA(macdLine, signalPeriod);
  const latestLine = macdLine[macdLine.length - 1];
  const latestSignal = signalArr[signalArr.length - 1];
  if (latestSignal === null) return null;
  return {
    line: Math.round(latestLine * 100) / 100,
    signal: Math.round(latestSignal * 100) / 100,
    histogram: Math.round((latestLine - latestSignal) * 100) / 100,
  };
}

/**
 * Anchored Intraday VWAP.
 * Accumulates typical price * volume from the beginning of the latest trading session.
 */
export function computeVWAP(candles: OhlcvCandle[]): number | null {
  if (candles.length === 0) return null;

  // Find index of first candle of the current session date
  const lastDate = candles[candles.length - 1].timestamp.slice(0, 10);
  let sessionStartIndex = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].timestamp.slice(0, 10) !== lastDate) {
      sessionStartIndex = i + 1;
      break;
    }
  }

  const sessionCandles = candles.slice(sessionStartIndex);
  let pvSum = 0;
  let volSum = 0;
  for (const c of sessionCandles) {
    const typical = (c.highMinor + c.lowMinor + c.closeMinor) / 3;
    pvSum += typical * c.volume;
    volSum += c.volume;
  }
  if (volSum <= 0) return null;
  return Math.round(pvSum / volSum);
}

export function computeATR(candles: OhlcvCandle[], period = 14): number | null {
  if (candles.length <= period) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].closeMinor;
    const tr = Math.max(
      cur.highMinor - cur.lowMinor,
      Math.abs(cur.highMinor - prevClose),
      Math.abs(cur.lowMinor - prevClose)
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return Math.round(atr);
}

export function computeAverageVolume(candles: OhlcvCandle[], period = 20): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const total = slice.reduce((acc, c) => acc + c.volume, 0);
  return Math.round(total / period);
}

export function computeSupportResistance(
  candles: OhlcvCandle[],
  lookback = 20
): { supportMinor: number | null; resistanceMinor: number | null } {
  if (candles.length === 0) return { supportMinor: null, resistanceMinor: null };
  const slice = candles.slice(-Math.min(lookback, candles.length));
  let supportMinor = slice[0].lowMinor;
  let resistanceMinor = slice[0].highMinor;
  for (const c of slice) {
    if (c.lowMinor < supportMinor) supportMinor = c.lowMinor;
    if (c.highMinor > resistanceMinor) resistanceMinor = c.highMinor;
  }
  return { supportMinor, resistanceMinor };
}

/**
 * Opening Range: High and Low of the first N bars of the current trading session (e.g. first 3 5m bars = 15m ORB).
 */
export function computeOpeningRange(
  candles: OhlcvCandle[],
  timeframeOrBars: any = 3,
  minutes?: number
): { highMinor: number; lowMinor: number; rangeDurationMinutes: number } | null {
  const barsCount =
    typeof timeframeOrBars === 'number'
      ? timeframeOrBars
      : typeof minutes === 'number'
      ? Math.max(1, Math.round(minutes / 5))
      : 3;
  if (!candles || candles.length < barsCount) return null;
  const lastDate = candles[candles.length - 1].timestamp.slice(0, 10);
  const sessionCandles = candles.filter((c) => c.timestamp.slice(0, 10) === lastDate);
  if (sessionCandles.length < barsCount) return null;

  const openingSlice = sessionCandles.slice(0, barsCount);
  let highMinor = openingSlice[0].highMinor;
  let lowMinor = openingSlice[0].lowMinor;
  for (const c of openingSlice) {
    if (c.highMinor > highMinor) highMinor = c.highMinor;
    if (c.lowMinor < lowMinor) lowMinor = c.lowMinor;
  }

  return {
    highMinor,
    lowMinor,
    rangeDurationMinutes: typeof minutes === 'number' ? minutes : barsCount * 5,
  };
}

export function computeTrendStrength(
  ema9: number | null,
  ema20: number | null,
  ema50: number | null,
  rsi: number | null
): IndicatorSnapshot['trendStrength'] {
  if (ema9 === null || ema20 === null || ema50 === null) return 'NEUTRAL';
  const rsiVal = rsi ?? 50;

  if (ema9 > ema20 && ema20 > ema50) {
    return rsiVal >= 55 ? 'STRONG_BULLISH' : 'BULLISH';
  }
  if (ema9 < ema20 && ema20 < ema50) {
    return rsiVal <= 45 ? 'STRONG_BEARISH' : 'BEARISH';
  }
  return 'NEUTRAL';
}

export function analyzeIndicators(candles: OhlcvCandle[]): IndicatorSnapshot {
  const closes = candles.map((c) => c.closeMinor);
  const ema9Arr = computeEMA(closes, 9);
  const ema20Arr = computeEMA(closes, 20);
  const ema50Arr = computeEMA(closes, 50);
  const { supportMinor, resistanceMinor } = computeSupportResistance(candles, 20);

  const ema9 = ema9Arr[ema9Arr.length - 1] ?? null;
  const ema20 = ema20Arr[ema20Arr.length - 1] ?? null;
  const ema50 = ema50Arr[ema50Arr.length - 1] ?? null;
  const rsi14 = computeRSI(closes, 14);
  const avgVol = computeAverageVolume(candles, 20);
  const curVol = candles.length > 0 ? candles[candles.length - 1].volume : 0;
  const volumeBreakoutRatio = avgVol && avgVol > 0 ? Math.round((curVol / avgVol) * 100) / 100 : null;

  const orb = computeOpeningRange(candles, 3);

  return {
    vwapMinor: computeVWAP(candles),
    rsi14,
    macd: computeMACD(closes, 12, 26, 9),
    ema9Minor: ema9 !== null ? Math.round(ema9) : null,
    ema20Minor: ema20 !== null ? Math.round(ema20) : null,
    ema21Minor: ema20 !== null ? Math.round(ema20) : null,
    sma20Minor: ema20 !== null ? Math.round(ema20) : null,
    ema50Minor: ema50 !== null ? Math.round(ema50) : null,
    atr14Minor: computeATR(candles, 14),
    avgVolume20: avgVol,
    supportMinor,
    resistanceMinor,
    openingRangeMinor: orb,
    openingRangeHighMinor: orb?.highMinor,
    openingRangeLowMinor: orb?.lowMinor,
    volumeBreakoutRatio,
    trendStrength: computeTrendStrength(ema9, ema20, ema50, rsi14),
    warmupComplete: candles.length >= 50,
    candleCount: candles.length,
  };
}
