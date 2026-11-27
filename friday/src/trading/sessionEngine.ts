// ============================================================
// FRIDAY — Exchange-Aware Trading Calendar & Session Engine
// Deterministic session states, Indian market holidays & candle boundaries
// ============================================================

import { ExchangeCode, MarketSessionInfo, MarketSessionState, Timeframe } from './tradingTypes';

export const NSE_BSE_HOLIDAYS_2026: Record<string, string> = {
  '2026-01-26': 'Republic Day',
  '2026-02-17': 'Mahashivratri',
  '2026-03-03': 'Holi',
  '2026-03-20': 'Id-ul-Fitr (Ramzan Id)',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-27': 'Bakri Id (Id-Ul-Zuha)',
  '2026-08-15': 'Independence Day',
  '2026-08-26': 'Milad-un-Nabi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-08': 'Diwali Laxmi Pujan (Muhurat Trading in Evening)',
  '2026-11-10': 'Diwali Balipratipada',
  '2026-11-24': 'Gurunanak Jayanti',
  '2026-12-25': 'Christmas',
};

export class MarketSessionEngine {
  private readonly timezone = 'Asia/Kolkata';

  /**
   * Convert any date into an Asia/Kolkata (+05:30) date parts representation.
   */
  getIstParts(date: Date = new Date()): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    dayOfWeek: number; // 0 = Sun, 6 = Sat
    dateIso: string;
    formatted: string;
  } {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
    });

    const parts = formatter.formatToParts(date);
    const getVal = (type: string) => parts.find((p) => p.type === type)?.value || '0';

    const year = parseInt(getVal('year'), 10);
    const month = parseInt(getVal('month'), 10);
    const day = parseInt(getVal('day'), 10);
    const hour = parseInt(getVal('hour'), 10) % 24;
    const minute = parseInt(getVal('minute'), 10);
    const second = parseInt(getVal('second'), 10);

    const weekdayStr = getVal('weekday').toLowerCase();
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dayOfWeek = days.indexOf(weekdayStr.slice(0, 3));

    const yStr = String(year).padStart(4, '0');
    const mStr = String(month).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    const dateIso = `${yStr}-${mStr}-${dStr}`;

    const displayFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
      dayOfWeek: dayOfWeek >= 0 ? dayOfWeek : date.getUTCDay(),
      dateIso,
      formatted: displayFormatter.format(date),
    };
  }

  /**
   * Check whether a given date is an official trading day on NSE/BSE.
   */
  isTradingDay(date: Date = new Date()): boolean {
    const parts = this.getIstParts(date);
    if (parts.dayOfWeek === 0 || parts.dayOfWeek === 6) {
      // Muhurat trading special session check on Sunday 2026-11-08
      if (parts.dateIso === '2026-11-08') return true;
      return false;
    }
    // Check holiday list
    if (NSE_BSE_HOLIDAYS_2026[parts.dateIso] && parts.dateIso !== '2026-11-08') {
      return false;
    }
    return true;
  }

  /**
   * Evaluates the current market session state for NSE / BSE.
   */
  getSessionStatus(date: Date = new Date(), exchange: ExchangeCode = 'NSE'): MarketSessionInfo {
    const ist = this.getIstParts(date);
    const timeMinutes = ist.hour * 60 + ist.minute;

    // Muhurat trading exception
    if (ist.dateIso === '2026-11-08') {
      const muhuratStart = 18 * 60 + 15; // 18:15 IST
      const muhuratEnd = 19 * 60 + 15; // 19:15 IST
      if (timeMinutes >= muhuratStart && timeMinutes < muhuratEnd) {
        return {
          exchange,
          state: 'SPECIAL_SESSION',
          isOpenForTrading: true,
          isOpen: true,
          isPreOpen: false,
          timezone: this.timezone,
          exchangeTimeFormatted: ist.formatted,
          sessionStartIst: '18:15',
          sessionEndIst: '19:15',
          nextSessionOpenIso: new Date(date.getTime() + 60_000).toISOString(),
          nextSessionOpen: new Date(date.getTime() + 60_000).toISOString(),
          holidayName: 'Diwali Muhurat Trading',
          holiday: { name: 'Diwali Muhurat Trading' },
          isMuhuratTrading: true,
          description: 'Special Diwali Muhurat Trading session is currently active.',
        };
      }
    }

    // Weekend
    if (ist.dayOfWeek === 0 || ist.dayOfWeek === 6) {
      const nextOpen = this.getNextSessionOpen(date);
      const isMuhuratDay = ist.dateIso === '2026-11-08';
      const holidayName = isMuhuratDay ? 'Diwali Laxmi Pujan (Muhurat Trading)' : undefined;
      return {
        exchange,
        state: isMuhuratDay ? 'CLOSED_HOLIDAY' : 'CLOSED_WEEKEND',
        isOpenForTrading: false,
        isOpen: false,
        isPreOpen: false,
        timezone: this.timezone,
        exchangeTimeFormatted: ist.formatted,
        sessionStartIst: '09:15',
        sessionEndIst: '15:30',
        nextSessionOpenIso: nextOpen.toISOString(),
        nextSessionOpen: nextOpen.toISOString(),
        holidayName,
        holiday: holidayName ? { name: holidayName } : undefined,
        description: isMuhuratDay
          ? 'Market is closed for Diwali Laxmi Pujan (Muhurat trading at 18:15 IST).'
          : `Market is closed for the weekend. Next regular trading session opens at 09:15 IST on ${this.getIstParts(nextOpen).formatted}.`,
      };
    }

    // Official Holiday
    const holidayName = NSE_BSE_HOLIDAYS_2026[ist.dateIso];
    if (holidayName && ist.dateIso !== '2026-11-08') {
      const nextOpen = this.getNextSessionOpen(date);
      return {
        exchange,
        state: 'CLOSED_HOLIDAY',
        isOpenForTrading: false,
        isOpen: false,
        isPreOpen: false,
        timezone: this.timezone,
        exchangeTimeFormatted: ist.formatted,
        sessionStartIst: '09:15',
        sessionEndIst: '15:30',
        nextSessionOpenIso: nextOpen.toISOString(),
        nextSessionOpen: nextOpen.toISOString(),
        holidayName,
        holiday: { name: holidayName },
        description: `Market is closed for ${holidayName}. Next session opens at 09:15 IST on ${this.getIstParts(nextOpen).formatted}.`,
      };
    }

    // Weekday: Evaluate Time-of-Day Segments
    // 09:00 - 09:15: Pre-Open
    if (timeMinutes >= 9 * 60 && timeMinutes < 9 * 60 + 15) {
      const nextIso = new Date(date.getTime() + (9 * 60 + 15 - timeMinutes) * 60_000).toISOString();
      return {
        exchange,
        state: 'PRE_OPEN',
        isOpenForTrading: false,
        isOpen: false,
        isPreOpen: true,
        timezone: this.timezone,
        exchangeTimeFormatted: ist.formatted,
        sessionStartIst: '09:00',
        sessionEndIst: '09:15',
        nextSessionOpenIso: nextIso,
        nextSessionOpen: nextIso,
        description: 'Pre-open auction session is active. Regular market opens at 09:15 IST.',
      };
    }

    // 09:15 - 15:30: Regular Market Session
    if (timeMinutes >= 9 * 60 + 15 && timeMinutes < 15 * 60 + 30) {
      return {
        exchange,
        state: 'REGULAR_OPEN',
        isOpenForTrading: true,
        isOpen: true,
        isPreOpen: false,
        timezone: this.timezone,
        exchangeTimeFormatted: ist.formatted,
        sessionStartIst: '09:15',
        sessionEndIst: '15:30',
        nextSessionOpenIso: date.toISOString(),
        nextSessionOpen: date.toISOString(),
        description: 'Regular trading session is currently open (09:15–15:30 IST).',
      };
    }

    // 15:30 - 16:00: Post-Close Closing Session
    if (timeMinutes >= 15 * 60 + 30 && timeMinutes < 16 * 60) {
      const nextOpen = this.getNextSessionOpen(date);
      return {
        exchange,
        state: 'POST_CLOSE',
        isOpenForTrading: false,
        isOpen: false,
        isPreOpen: false,
        timezone: this.timezone,
        exchangeTimeFormatted: ist.formatted,
        sessionStartIst: '15:30',
        sessionEndIst: '16:00',
        nextSessionOpenIso: nextOpen.toISOString(),
        nextSessionOpen: nextOpen.toISOString(),
        description: 'Post-closing session active. Next regular session opens at 09:15 IST tomorrow.',
      };
    }

    // Overnight Closed (< 09:00 or >= 16:00)
    const nextOpen = this.getNextSessionOpen(date);
    return {
      exchange,
      state: 'CLOSED_OVERNIGHT',
      isOpenForTrading: false,
      isOpen: false,
      isPreOpen: false,
      timezone: this.timezone,
      exchangeTimeFormatted: ist.formatted,
      sessionStartIst: '09:15',
      sessionEndIst: '15:30',
      nextSessionOpenIso: nextOpen.toISOString(),
      nextSessionOpen: nextOpen.toISOString(),
      description: `Market is closed for the day. Next regular session opens at 09:15 IST on ${this.getIstParts(nextOpen).formatted}.`,
    };
  }

  /**
   * Find the next upcoming 09:15 IST regular session open timestamp.
   */
  getNextSessionOpen(fromDate: Date = new Date()): Date {
    const candidate = new Date(fromDate.getTime());
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 5);

    for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
      const ist = this.getIstParts(candidate);
      const isDayValid = this.isTradingDay(candidate);

      if (isDayValid) {
        const timeMinutes = ist.hour * 60 + ist.minute;
        if (timeMinutes < 9 * 60 + 15) {
          // Opens today at 09:15 IST (+05:30 -> 03:45 UTC)
          const targetUtc = new Date(
            Date.UTC(ist.year, ist.month - 1, ist.day, 3, 45, 0, 0)
          );
          return targetUtc;
        }
      }

      // Advance to next day at 00:00 UTC
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
    }

    return new Date(fromDate.getTime() + 86400_000);
  }

  /**
   * Returns regular 09:15-15:30 IST candle boundary intervals for an intraday session.
   */
  getIntradayCandleBoundaries(
    sessionDateIso: string,
    timeframe: Timeframe = '5m'
  ): { startIso: string; endIso: string }[] {
    const [y, m, d] = sessionDateIso.split('-').map((v) => parseInt(v, 10));
    // 09:15 IST = 03:45 UTC, 15:30 IST = 10:00 UTC
    const startMs = Date.UTC(y, m - 1, d, 3, 45, 0, 0);
    const endMs = Date.UTC(y, m - 1, d, 10, 0, 0, 0);

    const stepMs =
      timeframe === '5m'
        ? 5 * 60_000
        : timeframe === '15m'
        ? 15 * 60_000
        : 60 * 60_000;

    const intervals: { startIso: string; endIso: string }[] = [];
    let cur = startMs;
    while (cur + stepMs <= endMs) {
      intervals.push({
        startIso: new Date(cur).toISOString(),
        endIso: new Date(cur + stepMs).toISOString(),
      });
      cur += stepMs;
    }

    return intervals;
  }
}

let _sessionEngine: MarketSessionEngine | null = null;

export function getMarketSessionEngine(): MarketSessionEngine {
  if (!_sessionEngine) {
    _sessionEngine = new MarketSessionEngine();
  }
  return _sessionEngine;
}
