// ============================================================
// FRIDAY — Exact Decimal-Safe Monetary Arithmetic (Minor Units)
// Stores & computes amounts as integer minor units (e.g. paise/cents)
// Never uses IEEE-754 floats for persisted monetary math
// ============================================================

export type MinorUnits = number; // Safe integer up to Number.MAX_SAFE_INTEGER (~9e15)

const SCALE = 100; // 2 decimal places (paise / cents)

/**
 * Parse a numeric or decimal string (e.g. "1234.56", 1234.56) into exact integer minor units.
 */
export function toMinorUnits(amount: number | string): MinorUnits {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) {
      throw new Error('Monetary amount must be a finite number');
    }
    return toMinorUnits(amount.toFixed(2));
  }
  const trimmed = String(amount).trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid monetary amount: "${amount}"`);
  }
  const negative = Boolean(match[1]);
  const whole = Number(match[2]);
  const fracRaw = match[3] || '';
  const fracPadded = (fracRaw + '000').slice(0, 3);
  const twoDigits = Number(fracPadded.slice(0, 2));
  const thirdDigit = Number(fracPadded[2]);
  // Half-up rounding on 3rd decimal digit
  const roundedFrac = thirdDigit >= 5 ? twoDigits + 1 : twoDigits;
  const total = whole * SCALE + roundedFrac;
  const result = negative ? -total : total;
  if (!Number.isSafeInteger(result)) {
    throw new Error('Monetary amount exceeds safe integer precision');
  }
  return result;
}

/**
 * Format integer minor units into a fixed 2-decimal string (e.g. 123456 -> "1234.56").
 */
export function formatMinorUnits(minor: MinorUnits): string {
  const safe = Math.trunc(minor);
  const neg = safe < 0;
  const abs = Math.abs(safe);
  const whole = Math.floor(abs / SCALE);
  const frac = String(abs % SCALE).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export function fromMinorUnits(minor: MinorUnits): number {
  return Number(formatMinorUnits(minor));
}

export function addMinor(...values: MinorUnits[]): MinorUnits {
  return values.reduce((acc, v) => acc + Math.trunc(v), 0);
}

export function subMinor(a: MinorUnits, b: MinorUnits): MinorUnits {
  return Math.trunc(a) - Math.trunc(b);
}

/**
 * Multiply minor units by a rational percentage (e.g. basis points or decimal rate) using integer rounding.
 * pct is in percent (e.g. 12.5 => 1250 bps).
 */
export function percentOfMinor(minor: MinorUnits, pct: number): MinorUnits {
  const bps = Math.round(pct * 100);
  return Math.round((Math.trunc(minor) * bps) / 10_000);
}

/**
 * Compute exact percentage (0..100, rounded to 2 decimals) of part / total.
 */
export function ratioPercent(partMinor: MinorUnits, totalMinor: MinorUnits): number {
  if (totalMinor === 0) return 0;
  const bps = Math.round((Math.trunc(partMinor) * 10_000) / Math.trunc(totalMinor));
  return bps / 100;
}
