// ============================================================
// FRIDAY — AI & OpenRouter Configuration
// Validates backend credentials without ever exposing secrets
// ============================================================

import { AIModelCapabilities } from '../providers/AIProvider';

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_APP_NAME = 'FRIDAY';
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 60_000;
export const DEFAULT_OPENROUTER_MAX_RETRIES = 2;

export type AITaskCategory = 'general' | 'reasoning' | 'coding' | 'research' | 'tool_calling';

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  siteUrl: string;
  appName: string;
  timeoutMs: number;
  maxRetries: number;
  taskModels?: Partial<Record<AITaskCategory, string>>;
}

/**
 * Load OpenRouter configuration exclusively from backend environment variables.
 * Never hardcodes API keys or arbitrary model names.
 */
export function loadAIConfig(): OpenRouterConfig {
  const timeoutRaw = parseInt(process.env.OPENROUTER_TIMEOUT_MS || String(DEFAULT_OPENROUTER_TIMEOUT_MS), 10);
  const retriesRaw = parseInt(process.env.OPENROUTER_MAX_RETRIES || String(DEFAULT_OPENROUTER_MAX_RETRIES), 10);

  return {
    apiKey: (process.env.OPENROUTER_API_KEY || '').trim(),
    model: (process.env.OPENROUTER_MODEL || '').trim(),
    baseUrl: ((process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).trim()).replace(/\/+$/, ''),
    siteUrl: (process.env.OPENROUTER_SITE_URL || '').trim(),
    appName: (process.env.OPENROUTER_APP_NAME || DEFAULT_OPENROUTER_APP_NAME).trim() || DEFAULT_OPENROUTER_APP_NAME,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_OPENROUTER_TIMEOUT_MS,
    maxRetries: Number.isFinite(retriesRaw) && retriesRaw >= 0 ? Math.min(retriesRaw, 5) : DEFAULT_OPENROUTER_MAX_RETRIES,
  };
}

/**
 * Validate OpenRouter configuration. Returns human-readable error strings
 * without exposing credential values.
 */
export function validateAIConfig(config: OpenRouterConfig): string[] {
  const errors: string[] = [];

  if (!config.apiKey) {
    errors.push('OPENROUTER_API_KEY is missing. Set it in friday/.env for AI inference.');
  }

  if (!config.model) {
    errors.push('OPENROUTER_MODEL is missing. Set OPENROUTER_MODEL in friday/.env (e.g. openai/gpt-4o-mini).');
  }

  if (!config.baseUrl || !/^https?:\/\/.+/i.test(config.baseUrl)) {
    errors.push(`Invalid OPENROUTER_BASE_URL: "${config.baseUrl || '(empty)'}"`);
  } else {
    try {
      const parsed = new URL(config.baseUrl);
      const isLoopback =
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '::1' ||
        parsed.hostname === '[::1]';
      if (parsed.protocol !== 'https:' && !isLoopback) {
        errors.push(`Insecure OPENROUTER_BASE_URL "${config.baseUrl}": production OpenRouter endpoints must use HTTPS.`);
      }
    } catch {
      errors.push(`Malformed OPENROUTER_BASE_URL: "${config.baseUrl}"`);
    }
  }

  return errors;
}

/**
 * Conservative capability inference for a configured OpenRouter model.
 * Callers can override with live metadata from /models when available.
 */
export function inferModelCapabilities(modelId: string): AIModelCapabilities {
  const lower = (modelId || '').toLowerCase();
  const isLegacyInstruct = lower.includes('instruct') && !lower.includes('gpt-4') && !lower.includes('claude');
  const isReasoningOnly = lower.includes('o1-mini') || lower.includes('o1-preview');

  return {
    streaming: true,
    toolCalling: !isLegacyInstruct && !isReasoningOnly,
    structuredOutput: !isLegacyInstruct && !isReasoningOnly,
    maxContextTokens: lower.includes('claude') ? 200_000 : lower.includes('gemini') ? 128_000 : 32_000,
  };
}
