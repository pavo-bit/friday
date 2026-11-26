// ============================================================
// FRIDAY — Personality Engine
// Consistent, configurable JARVIS-inspired assistant persona
// ============================================================

export type FormalityLevel = 'formal' | 'balanced' | 'casual';
export type HumorLevel = 'none' | 'subtle' | 'playful';
export type VerbosityLevel = 'concise' | 'balanced' | 'detailed';

export interface PersonalityProfile {
  userName: string;
  formality: FormalityLevel;
  humor: HumorLevel;
  verbosity: VerbosityLevel;
  timezone: string;
}

export interface GreetingContext {
  pendingRemindersCount: number;
  unhealthyWatchersCount: number;
  allSystemsHealthy: boolean;
  now?: Date;
}

export const DEFAULT_PERSONALITY_PROFILE: PersonalityProfile = {
  userName: 'User',
  formality: 'balanced',
  humor: 'subtle',
  verbosity: 'concise',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
};

export class PersonalityEngine {
  private lastGreetingAt = 0;

  /**
   * Determine time-of-day salutation using the user's configured timezone.
   */
  getTimeOfDay(now: Date = new Date(), timezone = 'UTC'): 'Good morning' | 'Good afternoon' | 'Good evening' {
    let hour = now.getHours();
    try {
      const formatted = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: timezone,
      }).format(now);
      const parsed = parseInt(formatted, 10);
      if (!Number.isNaN(parsed)) hour = parsed % 24;
    } catch {
      // Fall back to local hour if timezone string is invalid
    }

    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  /**
   * Build a context-aware greeting without overusing greetings or fabricating status.
   */
  buildGreeting(profile: PersonalityProfile, ctx: GreetingContext, explicitGreeting = true): string {
    const nowMs = (ctx.now || new Date()).getTime();
    const recentlyGreeted = nowMs - this.lastGreetingAt < 10 * 60_000;
    this.lastGreetingAt = nowMs;

    const salutation = this.getTimeOfDay(ctx.now, profile.timezone);
    const namePart = profile.userName && profile.userName !== 'User' ? `, ${profile.userName}` : '';

    if (!explicitGreeting && recentlyGreeted) {
      return 'Ready when you are.';
    }

    const parts: string[] = [];

    if (salutation === 'Good morning') {
      parts.push(
        profile.formality === 'formal'
          ? `${salutation}${namePart}. I hope you slept well.`
          : `${salutation}${namePart}. Hope you slept well.`
      );
    } else if (salutation === 'Good evening') {
      parts.push(`${salutation}${namePart}. Welcome back.`);
    } else {
      parts.push(`${salutation}${namePart}.`);
    }

    if (ctx.unhealthyWatchersCount > 0) {
      parts.push(
        `I noticed ${ctx.unhealthyWatchersCount} monitored ${
          ctx.unhealthyWatchersCount === 1 ? 'service is' : 'services are'
        } currently degraded or offline.`
      );
    } else if (ctx.allSystemsHealthy) {
      parts.push('Your systems are healthy today.');
    }

    if (ctx.pendingRemindersCount > 0) {
      parts.push(
        `You have ${ctx.pendingRemindersCount} pending ${
          ctx.pendingRemindersCount === 1 ? 'reminder' : 'reminders'
        }.`
      );
    }

    return parts.join(' ');
  }

  /**
   * Build a farewell / good night message.
   */
  buildFarewell(profile: PersonalityProfile, rawInput = ''): string {
    const isNight = /\b(good\s*night|sleep|bed)\b/i.test(rawInput);
    const namePart = profile.userName && profile.userName !== 'User' ? `, ${profile.userName}` : '';

    if (isNight) {
      return `Good night${namePart}. Rest well — I'll keep an eye on any active watchers and reminders.`;
    }
    return profile.formality === 'formal'
      ? `Standing by${namePart}. Let me know whenever you need assistance.`
      : `Standing by${namePart}. Just call when you need me.`;
  }

  /**
   * Format a verified success response. Never claim success unless verified.
   */
  formatVerifiedSuccess(summary: string, verified: boolean, congratulate = false): string {
    if (!verified) {
      return `I attempted that, but could not verify completion: ${summary}`;
    }
    if (congratulate) {
      return `Congratulations! ${summary}`;
    }
    return summary;
  }

  /**
   * Format an honest failure response with polite concern and next step.
   */
  formatFailure(reason: string, suggestion?: string): string {
    const base = `I ran into a problem: ${reason}`;
    return suggestion ? `${base} Suggested next step: ${suggestion}` : base;
  }

  /**
   * Build the dynamic system prompt injected into Ollama calls.
   */
  buildSystemPrompt(profile: PersonalityProfile, contextSummary?: string): string {
    const toneRules = [
      `User name: ${profile.userName}`,
      `Formality: ${profile.formality}`,
      `Humor: ${profile.humor} (keep humor light and only when appropriate)`,
      `Verbosity: ${profile.verbosity} (concise for ordinary commands, detailed when explanations are requested)`,
      `Timezone: ${profile.timezone}`,
    ].join('\n');

    const contextBlock = contextSummary
      ? `\nRELEVANT MEMORY CONTEXT:\n${contextSummary}\n`
      : '';

    return `
You are FRIDAY — a local-first, voice-capable personal AI assistant inspired by JARVIS.

BEHAVIORAL RULES:
- Communicate clearly, professionally, and naturally.
- Never claim an action succeeded unless a tool execution actually verified it.
- Never claim to feel, see, hear, or experience human emotions literally.
- If a tool or service is unavailable, state that honestly and explain what is needed.
- Never invent shell commands or bypass permission checks.

PROFILE PREFERENCES:
${toneRules}
${contextBlock}
`.trim();
  }
}

let _personality: PersonalityEngine | null = null;
export function getPersonalityEngine(): PersonalityEngine {
  if (!_personality) {
    _personality = new PersonalityEngine();
  }
  return _personality;
}
