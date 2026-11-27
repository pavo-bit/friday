// ============================================================
// FRIDAY — AI Provider Errors & Secret Redaction
// Typed error hierarchy for cloud LLM inference
// ============================================================

export type AIErrorCode =
  | 'MISSING_API_KEY'
  | 'MISSING_MODEL'
  | 'INVALID_CREDENTIALS'
  | 'INSUFFICIENT_CREDITS'
  | 'PERMISSION_DENIED'
  | 'MODEL_OR_ENDPOINT_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'CANCELLED'
  | 'MALFORMED_RESPONSE'
  | 'CONTEXT_OVERFLOW'
  | 'UNKNOWN_ERROR';

/**
 * Redact API keys and Bearer tokens from error messages and log payloads.
 */
export function redactProviderSecrets(input: string): string {
  if (!input) return input;
  return input
    .replace(/\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]')
    .replace(/\b(sk-or-v1-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,})\b/g, '[REDACTED_API_KEY]');
}

export class AIProviderError extends Error {
  readonly code: AIErrorCode;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly correlationId?: string;
  readonly provider: string;

  constructor(params: {
    code: AIErrorCode;
    message: string;
    provider?: string;
    statusCode?: number;
    retryable?: boolean;
    correlationId?: string;
    cause?: unknown;
  }) {
    super(redactProviderSecrets(params.message));
    this.name = 'AIProviderError';
    this.code = params.code;
    this.provider = params.provider || 'openrouter';
    this.statusCode = params.statusCode;
    this.retryable = Boolean(params.retryable);
    this.correlationId = params.correlationId;
    if (params.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = params.cause;
    }
  }
}

/**
 * Map an HTTP status code and response body from OpenRouter into a typed AIProviderError.
 */
export function classifyHttpError(
  statusCode: number,
  rawBody: string,
  correlationId?: string,
  provider = 'openrouter'
): AIProviderError {
  const safeBody = redactProviderSecrets(rawBody).slice(0, 240);
  const lower = safeBody.toLowerCase();

  if (statusCode === 401) {
    return new AIProviderError({
      code: 'INVALID_CREDENTIALS',
      statusCode,
      retryable: false,
      correlationId,
      provider,
      message: `OpenRouter authentication failed (401): invalid or revoked API credentials.`,
    });
  }
  if (statusCode === 402) {
    return new AIProviderError({
      code: 'INSUFFICIENT_CREDITS',
      statusCode,
      retryable: false,
      correlationId,
      provider,
      message: `OpenRouter insufficient provider credits (402): ${safeBody || 'account credit balance exhausted.'}`,
    });
  }
  if (statusCode === 403) {
    return new AIProviderError({
      code: 'PERMISSION_DENIED',
      statusCode,
      retryable: false,
      correlationId,
      provider,
      message: `OpenRouter access or model permission denied (403): ${safeBody || 'check model access policy.'}`,
    });
  }
  if (statusCode === 404) {
    return new AIProviderError({
      code: 'MODEL_OR_ENDPOINT_NOT_FOUND',
      statusCode,
      retryable: false,
      correlationId,
      provider,
      message: `OpenRouter model or endpoint not found (404): ${safeBody || 'verify OPENROUTER_MODEL.'}`,
    });
  }
  if (statusCode === 429) {
    return new AIProviderError({
      code: 'RATE_LIMITED',
      statusCode,
      retryable: true,
      correlationId,
      provider,
      message: `OpenRouter rate limit exceeded (429): ${safeBody || 'retry after backoff.'}`,
    });
  }
  if (
    statusCode === 400 &&
    (lower.includes('context') || lower.includes('maximum context length') || lower.includes('too many tokens'))
  ) {
    return new AIProviderError({
      code: 'CONTEXT_OVERFLOW',
      statusCode,
      retryable: false,
      correlationId,
      provider,
      message: `OpenRouter context window exceeded (400): ${safeBody}`,
    });
  }
  if (statusCode >= 500) {
    return new AIProviderError({
      code: 'SERVER_ERROR',
      statusCode,
      retryable: true,
      correlationId,
      provider,
      message: `OpenRouter server error (${statusCode}): ${safeBody || 'upstream provider failure.'}`,
    });
  }

  return new AIProviderError({
    code: 'UNKNOWN_ERROR',
    statusCode,
    retryable: false,
    correlationId,
    provider,
    message: `OpenRouter HTTP ${statusCode}: ${safeBody || 'unexpected error.'}`,
  });
}
