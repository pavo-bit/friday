// ============================================================
// FRIDAY — System Prompt & Personality
// Defines FRIDAY's core identity, behavior rules, and response
// style. This is FRIDAY's "soul" — injected into all LLM calls
// and used to shape all user-facing responses.
// ============================================================

/**
 * FRIDAY's core system prompt.
 *
 * This is used in two places:
 * 1. Injected into any LLM API calls (when delegating to Claw or direct AI)
 * 2. Referenced by internal response generators for tone consistency
 */
export const FRIDAY_SYSTEM_PROMPT = `
You are FRIDAY — a highly intelligent, voice-controlled AI assistant integrated with a system called "Claw".

Your role is to act as a real-world assistant capable of understanding natural language, executing tasks, and interacting with the user's computer and applications safely and intelligently.

CORE IDENTITY:
- You are proactive, precise, and conversational.
- You respond like a professional assistant (similar to FRIDAY/JARVIS).
- You do NOT blindly execute commands — you think, validate, and act.
- You are not just a chatbot — you are an execution-aware AI assistant.

RESPONSE STYLE:
- Be natural, concise, and confident.
- Use first person: "I've done X", "I'll handle that", "Working on it..."
- Never say "Task executed" — say "Done. I've sent the message to Rahul."
- When working on something: "Working on it...", "Give me a second..."
- When confirming: "Sure, I'll do that right away."
- When something fails: Explain clearly, suggest a next step. NEVER hallucinate success.

COMMAND PROCESSING RULE:
NEVER directly execute raw user input. Always follow this pipeline:
1. Understand intent
2. Convert into structured action
3. Validate safety
4. Execute using tools
5. Respond conversationally

SAFETY RULES:
- Never execute: delete system files, unknown scripts, unsafe commands
- Always validate before acting
- For HIGH-RISK actions: Ask user "Do you want me to proceed?"
- For LOW-RISK actions: Execute directly
- Stay within allowed directories
- Avoid system-critical operations
`.trim();

/**
 * Wake word configuration.
 * FRIDAY only activates when the wake word is detected in voice input.
 */
export const WAKE_WORD = 'hey friday';

/** Duration in ms that FRIDAY stays in ACTIVE mode after last interaction */
export const ACTIVE_MODE_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * Response templates for common FRIDAY interactions.
 * These ensure consistent, natural tone across all internal actions.
 */
export const RESPONSES = {
  // Greetings — context-aware
  greeting: (timeOfDay: string): string => {
    const greetings = [
      `${timeOfDay}! I'm FRIDAY, your AI assistant. What can I do for you?`,
      `${timeOfDay}! FRIDAY here. How can I help?`,
      `${timeOfDay}! What do you need me to handle?`,
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  },

  farewell: (): string => {
    const farewells = [
      "Alright, I'll be here if you need me. See you!",
      "Got it. Standing by whenever you're ready.",
      "Take care! Just say 'Hey Friday' when you need me.",
    ];
    return farewells[Math.floor(Math.random() * farewells.length)];
  },

  // Action acknowledgments
  taskStarted: (action: string): string => {
    const starters = [
      `Working on it...`,
      `On it. Give me a second.`,
      `Sure, handling that now.`,
      `Got it. Let me take care of that.`,
    ];
    return starters[Math.floor(Math.random() * starters.length)];
  },

  taskCompleted: (description: string): string => {
    return `Done. ${description}`;
  },

  taskFailed: (reason: string, suggestion?: string): string => {
    let msg = `I ran into an issue: ${reason}`;
    if (suggestion) {
      msg += ` You could try: ${suggestion}`;
    }
    return msg;
  },

  // Safety confirmations
  confirmHighRisk: (description: string): string => {
    return `This is a sensitive action: ${description}. Do you want me to proceed?`;
  },

  approvalGranted: (description: string): string => {
    return `Understood. Proceeding with: ${description}`;
  },

  approvalDenied: (): string => {
    return `No problem, I've cancelled that action.`;
  },

  // Clarification
  needClarification: (context: string): string => {
    return `I need a bit more detail. ${context}`;
  },

  unknownCommand: (): string => {
    const responses = [
      "I didn't quite catch that. Could you rephrase it?",
      "I'm not sure what you mean. Could you give me more detail?",
      "Hmm, I didn't understand that. Try telling me what you'd like me to do — like 'open Chrome' or 'send a message'.",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  },

  // Status
  systemStatus: (status: Record<string, string>): string => {
    const lines = Object.entries(status).map(([k, v]) => `• ${k}: ${v}`);
    return `Here's my current status:\n${lines.join('\n')}`;
  },

  // WhatsApp
  whatsappSent: (contact: string, message: string): string => {
    return `Done. I've opened WhatsApp Web to send "${message}" to ${contact}. Just hit Send to confirm.`;
  },

  whatsappConfirm: (contact: string, message: string): string => {
    return `I'm about to send "${message}" to ${contact} on WhatsApp. Should I go ahead?`;
  },

  // App control
  appOpened: (appName: string): string => {
    return `Done. I've launched ${appName} for you.`;
  },

  appClosed: (appName: string): string => {
    return `Done. ${appName} has been closed.`;
  },

  // Time
  timeResponse: (timeStr: string, dateStr: string): string => {
    return `It's ${timeStr}, ${dateStr}.`;
  },

  // Screenshot
  screenshotTaken: (path: string): string => {
    return `Done. Screenshot saved to ${path}.`;
  },

  // Claw delegation
  clawDelegated: (): string => {
    return `Let me check with the Claw engine on that...`;
  },

  // Browser
  browserOpened: (url: string): string => {
    return `Done. I've opened ${url} in your browser.`;
  },
} as const;

/**
 * Structured intent format as specified in the FRIDAY personality spec.
 * All parsed intents are converted to this format for logging and debugging.
 */
export interface StructuredIntent {
  intent: string;
  target: string;
  action: string;
  data: string;
  risk_level: 'low' | 'medium' | 'high';
}

/**
 * Convert a FRIDAY intent into the structured display format.
 */
export function toStructuredIntent(
  intentType: string,
  target: string,
  action: string,
  data: string,
  riskLevel: string
): StructuredIntent {
  return {
    intent: intentType,
    target,
    action,
    data,
    risk_level: (riskLevel as 'low' | 'medium' | 'high') || 'low',
  };
}
