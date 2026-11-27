// ============================================================
// FRIDAY — Deterministic Technical Indicators
// VWAP, RSI(14), MACD(12,26,9), EMA(9,20,50), ATR(14),
// Average Volume(20), Support & Resistance
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

export function computeVWAP(candles: OhlcvCandle[]): number | null {
  if (candles.length === 0) return null;
  let pvSum = 0;
  let volSum = 0;
  for (const c of candles) {
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

export function analyzeIndicators(candles: OhlcvCandle[]): IndicatorSnapshot {
  const closes = candles.map((c) => c.closeMinor);
  const ema9Arr = computeEMA(closes, 9);
  const ema20Arr = computeEMA(closes, 20);
  const ema50Arr = computeEMA(closes, 50);
  const { supportMinor, resistanceMinor } = computeSupportResistance(candles, 20);

  const ema9 = ema9Arr[ema9Arr.length - 1] ?? null;
  const ema20 = ema20Arr[ema20Arr.length - 1] ?? null;
  const ema50 = ema50Arr[ema50Arr.length - 1] ?? null;

  return {
    vwapMinor: computeVWAP(candles),
    rsi14: computeRSI(closes, 14),
    macd: computeMACD(closes, 12, 26, 9),
    ema9Minor: ema9 !== null ? Math.round(ema9) : null,
    ema20Minor: ema20 !== null ? Math.round(ema20) : null,
    ema50Minor: ema50 !== null ? Math.round(ema50) : null,
    atr14Minor: computeATR(candles, 14),
    avgVolume20: computeAverageVolume(candles, 20),
    supportMinor,
    resistanceMinor,
    warmupComplete: candles.length >= 50,
    candleCount: candles.length,
  };
}
