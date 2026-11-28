// ============================================================
// FRIDAY — Greeting & Farewell Service
// Time-aware greeting/farewell classification and JARVIS-inspired salutations
// ============================================================

import { getMemoryStore } from '../memory/store';
import { getVoiceSettingsManager, isValidIanaTimezone } from './voiceSettings';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('GreetingService');

export type TimeOfDayPeriod = 'morning' | 'afternoon' | 'evening' | 'night';

export interface GreetingInfo {
  salutation: string;
  userName: string;
  period: TimeOfDayPeriod;
  localTimeFormatted: string;
  timezone: string;
  hour: number;
  minute: number;
}

export interface FarewellOptions {
  explicitGoodNight?: boolean;
  timezone?: string;
}

export class GreetingService {
  private cachedUserName = 'Boss';
  private lastWakeGreeting = '';
  private lastFarewell = '';

  setUserName(name: string): void {
    if (name && name.trim()) {
      this.cachedUserName = name.trim();
    }
  }

  /**
   * Resolves the authoritative timezone.
   * Prioritizes explicit override -> configured voice timezone -> system timezone -> 'Asia/Kolkata'.
   */
  resolveTimezone(overrideTimezone?: string): string {
    if (overrideTimezone && isValidIanaTimezone(overrideTimezone)) {
      return overrideTimezone;
    }

    const settings = getVoiceSettingsManager().getSettings();
    if (settings.timezone && isValidIanaTimezone(settings.timezone)) {
      return settings.timezone;
    }

    try {
      const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (systemTz && isValidIanaTimezone(systemTz)) {
        return systemTz;
      }
    } catch {
      // Ignore
    }

    return 'Asia/Kolkata';
  }

  /**
   * Deterministically classify the period of the day based on local hour (0-23).
   * 05:00 - 11:59 -> morning
   * 12:00 - 16:59 -> afternoon
   * 17:00 - 20:59 -> evening
   * 21:00 - 04:59 -> night (Good evening when greeting; Good night when saying farewell)
   */
  classifyTimeOfDay(hour: number): TimeOfDayPeriod {
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  }

  /**
   * Extracts local hour and minute for the specified timezone.
   */
  getLocalTimeParts(now: Date = new Date(), timezone = this.resolveTimezone()): {
    hour: number;
    minute: number;
    formatted: string;
  } {
    const safeTz = isValidIanaTimezone(timezone) ? timezone : 'Asia/Kolkata';
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: safeTz,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      });

      const parts = formatter.formatToParts(now);
      const hourPart = parts.find((p) => p.type === 'hour');
      const minPart = parts.find((p) => p.type === 'minute');

      const hour = hourPart ? parseInt(hourPart.value, 10) % 24 : now.getHours();
      const minute = minPart ? parseInt(minPart.value, 10) : now.getMinutes();

      const displayFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: safeTz,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });

      return {
        hour,
        minute,
        formatted: displayFormatter.format(now),
      };
    } catch {
      return {
        hour: now.getHours(),
        minute: now.getMinutes(),
        formatted: `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`,
      };
    }
  }

  /**
   * Generates a greeting info object based on local system clock.
   * Never returns "Good night" as a wake/greeting salutation.
   */
  getGreetingInfo(now: Date = new Date(), overrideTimezone?: string): GreetingInfo {
    const timezone = this.resolveTimezone(overrideTimezone);
    const { hour, minute, formatted } = this.getLocalTimeParts(now, timezone);
    const period = this.classifyTimeOfDay(hour);

    let salutation = 'Good evening';
    if (period === 'morning') salutation = 'Good morning';
    else if (period === 'afternoon') salutation = 'Good afternoon';
    else if (period === 'evening') salutation = 'Good evening';
    else salutation = 'Good evening'; // 21:00-04:59: Good evening when greeting

    const userName = this.cachedUserName || 'Boss';
    getMemoryStore()
      .then((store) => {
        const profile = store.getPersonalityProfile();
        if (profile && profile.userName) {
          this.cachedUserName = profile.userName;
        }
      })
      .catch(() => {
        // Fallback
      });

    return {
      salutation,
      userName,
      period,
      localTimeFormatted: formatted,
      timezone,
      hour,
      minute,
    };
  }

  /**
   * Produce a natural, professional spoken wake-up greeting string.
   * Avoids repeating the same greeting on consecutive activations.
   */
  generateWakeGreeting(now: Date = new Date(), overrideTimezone?: string): string {
    const info = this.getGreetingInfo(now, overrideTimezone);
    const name = info.userName || 'Boss';

    const variations: Record<TimeOfDayPeriod, string[]> = {
      morning: [
        `Good morning, ${name}. FRIDAY is online. I'm ready for your instructions.`,
        `Good morning, ${name}. All systems are operational. How may I assist you?`,
        `Good morning, ${name}. I'm ready when you are.`,
      ],
      afternoon: [
        `Good afternoon, ${name}. FRIDAY is online and ready to assist.`,
        `Good afternoon, ${name}. What would you like me to take care of?`,
        `Good afternoon, ${name}. I'm listening.`,
      ],
      evening: [
        `Good evening, ${name}. Welcome back. How may I assist you?`,
        `Good evening, ${name}. I'm online and ready for your instructions.`,
        `Good evening, ${name}. What can I take care of for you?`,
      ],
      night: [
        `Good evening, ${name}. I'm online. What do you need?`,
        `Welcome back, ${name}. FRIDAY is ready to assist.`,
      ],
    };

    const candidates = variations[info.period];
    const nonRepeating = candidates.filter((c) => c !== this.lastWakeGreeting);
    const pool = nonRepeating.length > 0 ? nonRepeating : candidates;
    const index = (now.getDate() + info.hour + info.minute) % pool.length;
    const chosen = pool[index];
    this.lastWakeGreeting = chosen;
    log.debug('Generated wake greeting', { period: info.period, timezone: info.timezone });
    return chosen;
  }

  /**
   * Produce a professional, time-aware farewell string based on the current local time
   * (or explicit "good night" request regardless of hour).
   */
  generateFarewell(now: Date = new Date(), options: FarewellOptions = {}): string {
    const info = this.getGreetingInfo(now, options.timezone);
    const name = info.userName || 'Boss';

    const isNightFarewell = Boolean(options.explicitGoodNight) || info.period === 'night';

    const daytimeFarewells = [
      `Certainly, ${name}. That will be all for now. Have a productive day.`,
      `Understood, ${name}. I'll be standing by. Have a pleasant day.`,
      `Very well, ${name}. Have a good day. I'll be here when you need me.`,
    ];

    const eveningFarewells = [
      `Of course, ${name}. Have a pleasant evening. I'll be standing by.`,
      `Understood, ${name}. Enjoy your evening. I'll be ready whenever you need me.`,
    ];

    const nightFarewells = [
      `Good night, ${name}. Have a restful night. I'll be standing by.`,
      `Good night, ${name}. Rest well. FRIDAY will be ready when you return.`,
    ];

    const candidates = isNightFarewell
      ? nightFarewells
      : info.period === 'evening'
        ? eveningFarewells
        : daytimeFarewells;

    const nonRepeating = candidates.filter((c) => c !== this.lastFarewell);
    const pool = nonRepeating.length > 0 ? nonRepeating : candidates;
    const index = (now.getDate() + info.hour + info.minute) % pool.length;
    const chosen = pool[index];
    this.lastFarewell = chosen;
    log.debug('Generated farewell', {
      period: info.period,
      explicitGoodNight: Boolean(options.explicitGoodNight),
      timezone: info.timezone,
    });
    return chosen;
  }
}

let _greetingService: GreetingService | null = null;

export function getGreetingService(): GreetingService {
  if (!_greetingService) {
    _greetingService = new GreetingService();
  }
  return _greetingService;
}
