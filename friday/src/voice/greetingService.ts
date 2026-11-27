// ============================================================
// FRIDAY — Greeting Service
// Time-aware greeting classification and personality salutations
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

export class GreetingService {
  private cachedUserName = 'Boss';

  setUserName(name: string): void {
    if (name && name.trim()) {
      this.cachedUserName = name.trim();
    }
  }
  /**
   * Resolves the authoritative timezone.
   * Prioritizes configured voice timezone -> system timezone -> 'Asia/Kolkata'.
   */
  resolveTimezone(): string {
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
   * 21:00 - 04:59 -> night
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
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
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
        timeZone: timezone,
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
        formatted: `${now.getHours()}:${now.getMinutes()}`,
      };
    }
  }

  /**
   * Generates a greeting info object based on local system clock.
   */
  getGreetingInfo(now: Date = new Date()): GreetingInfo {
    const timezone = this.resolveTimezone();
    const { hour, minute, formatted } = this.getLocalTimeParts(now, timezone);
    const period = this.classifyTimeOfDay(hour);

    let salutation = 'Good day';
    if (period === 'morning') salutation = 'Good morning';
    else if (period === 'afternoon') salutation = 'Good afternoon';
    else if (period === 'evening') salutation = 'Good evening';
    else if (period === 'night') salutation = 'Good evening'; // Spoken natural fallback for night

    let userName = this.cachedUserName;
    getMemoryStore().then((store) => {
      const profile = store.getPersonalityProfile();
      if (profile && profile.userName) {
        this.cachedUserName = profile.userName;
      }
    }).catch(() => {
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
   * Produce a natural, spoken wake-up greeting string.
   */
  generateWakeGreeting(now: Date = new Date()): string {
    const info = this.getGreetingInfo(now);
    const variations: Record<TimeOfDayPeriod, string[]> = {
      morning: [
        `${info.salutation}, ${info.userName}. I'm online and ready. What can I do for you?`,
        `${info.salutation}, ${info.userName}. All systems are standing by.`,
        `${info.salutation}, ${info.userName}. Ready when you are.`,
      ],
      afternoon: [
        `${info.salutation}, ${info.userName}. I'm here. What do you need?`,
        `${info.salutation}, ${info.userName}. Systems standing by. How can I help?`,
        `${info.salutation}, ${info.userName}. Ready for your command.`,
      ],
      evening: [
        `${info.salutation}, ${info.userName}. I'm listening. What can I do for you?`,
        `${info.salutation}, ${info.userName}. Systems are online. How can I assist?`,
        `${info.salutation}, ${info.userName}. Standing by for your instructions.`,
      ],
      night: [
        `Welcome back, ${info.userName}. Systems are quiet and standing by.`,
        `Good evening, ${info.userName}. I'm here if you need anything.`,
        `Online and listening, ${info.userName}. What can I do for you?`,
      ],
    };

    const options = variations[info.period];
    // Deterministic selection based on day of month + hour to vary naturally across the day
    const index = (now.getDate() + info.hour) % options.length;
    return options[index];
  }
}

let _greetingService: GreetingService | null = null;

export function getGreetingService(): GreetingService {
  if (!_greetingService) {
    _greetingService = new GreetingService();
  }
  return _greetingService;
}
