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
  userName: 'Boss',
  formality: 'balanced',
  humor: 'subtle',
  verbosity: 'concise',
  timezone: 'Asia/Kolkata',
};

export type TimePeriodGreeting =
  | 'Good morning'
  | 'Good afternoon'
  | 'Good evening'
  | 'Good night';

export class PersonalityEngine {
  private lastGreetingAt = 0;
  private lastGreetingText = '';

  /**
   * Determine time-of-day salutation using the system clock and configured timezone.
   */
  getTimeOfDay(now: Date = new Date(), timezone = 'Asia/Kolkata'): TimePeriodGreeting {
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
    if (hour >= 17 && hour < 21) return 'Good evening';
    return 'Good night';
  }

  /**
   * Build a context-aware greeting addressing the user as Boss,
   * avoiding identical consecutive greeting responses.
   */
  buildGreeting(profile: PersonalityProfile, ctx: GreetingContext, explicitGreeting = true): string {
    const nowMs = (ctx.now || new Date()).getTime();
    const recentlyGreeted = nowMs - this.lastGreetingAt < 10 * 60_000;
    this.lastGreetingAt = nowMs;

    const salutation = this.getTimeOfDay(ctx.now, profile.timezone);
    const name = profile.userName?.trim() || 'Boss';

    if (!explicitGreeting && recentlyGreeted) {
      return `Ready when you are, ${name}.`;
    }

    const candidatesByPeriod: Record<TimePeriodGreeting, string[]> = {
      'Good morning': [
        `Good morning, ${name}! Hope you slept well.`,
        `Good morning, ${name}. Ready to get started today?`,
        `Morning, ${name}. Systems are online and standing by.`,
      ],
      'Good afternoon': [
        `Good afternoon, ${name}. What are we working on today?`,
        `Good afternoon, ${name}. Ready whenever you are.`,
        `Afternoon, ${name}. How can I assist?`,
      ],
      'Good evening': [
        `Good evening, ${name}. I'm ready.`,
        `Good evening, ${name}. Welcome back.`,
        `Evening, ${name}. What's on the agenda?`,
      ],
      'Good night': [
        `Good night, ${name}. Have a peaceful rest.`,
        `Good night, ${name}. I'll keep watch on any active systems.`,
        `Working late, ${name}? Good night — let me know if you need anything before you rest.`,
      ],
    };

    const options = candidatesByPeriod[salutation].filter((c) => c !== this.lastGreetingText);
    const opener = options[Math.floor(Math.random() * options.length)] || candidatesByPeriod[salutation][0];
    this.lastGreetingText = opener;

    const parts: string[] = [opener];

    if (ctx.unhealthyWatchersCount > 0) {
      parts.push(
        `I noticed ${ctx.unhealthyWatchersCount} monitored ${
          ctx.unhealthyWatchersCount === 1 ? 'service is' : 'services are'
        } currently degraded or offline.`
      );
    } else if (ctx.allSystemsHealthy && salutation !== 'Good night') {
      parts.push('Your systems are healthy.');
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
