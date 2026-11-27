// ============================================================
// FRIDAY — OpenRouter Provider Implementation
// Typed OpenRouter /chat/completions client with streaming,
// tool calling, bounded retries, cancellation, and diagnostics
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { createLayerLogger } from '../../shared/logger';
import {
  AICompletionRequest,
  AICompletionResponse,
  AIProvider,
  AIProviderDiagnostics,
  AIProviderStatus,
  AIStreamRequest,
  AITokenUsage,
  AIToolCall,
} from './AIProvider';
import { loadAIConfig, OpenRouterConfig } from '../config/ai.config';
import { AIProviderError, classifyHttpError, redactProviderSecrets } from '../errors/AIProviderErrors';

const log = createLayerLogger('OpenRouter');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerVal: string | null): number | null {
  if (!headerVal) return null;
  const seconds = Number(headerVal);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000);
  }
  const dateMs = Date.parse(headerVal);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), 30_000));
  }
  return null;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const HEALTH_CACHE_TTL_MS = 15_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

export class OpenRouterProvider implements AIProvider {
  readonly name = 'openrouter';

  private lastLatencyMs: number | null = null;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastSuccessAt: string | null = null;
  private totalRequests = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private cachedStatus: { status: AIProviderStatus; expiresAt: number } | null = null;
  private circuitState: CircuitState = 'CLOSED';
  private circuitOpenedAt = 0;
  private halfOpenProbeInFlight = false;

  getCircuitState(): CircuitState {
    if (
      this.circuitState === 'OPEN' &&
      Date.now() - this.circuitOpenedAt >= CIRCUIT_BREAKER_COOLDOWN_MS
    ) {
      return 'HALF_OPEN';
    }
    return this.circuitState;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.lastSuccessAt = new Date().toISOString();
    this.circuitState = 'CLOSED';
    this.halfOpenProbeInFlight = false;
  }

  private recordFailure(message: string, countsTowardBreaker = true): void {
    this.lastError = message;
    this.cachedStatus = null;
    this.halfOpenProbeInFlight = false;
    if (countsTowardBreaker) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitState = 'OPEN';
        this.circuitOpenedAt = Date.now();
      }
    }
  }

  private getConfig(): OpenRouterConfig {
    return loadAIConfig();
  }

  private buildHeaders(cfg: OpenRouterConfig, correlationId: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      'X-Correlation-ID': correlationId,
    };
    if (cfg.siteUrl) {
      headers['HTTP-Referer'] = cfg.siteUrl;
    }
    if (cfg.appName) {
      headers['X-Title'] = cfg.appName;
    }
    return headers;
  }

  private createRequestSignal(timeoutMs: number, externalSignal?: AbortSignal): {
    signal: AbortSignal;
    cleanup: () => void;
    wasTimeout: () => boolean;
  } {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`OpenRouter request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onExternalAbort = () => {
      controller.abort(externalSignal?.reason || new Error('Request cancelled'));
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    return {
      signal: controller.signal,
      wasTimeout: () => timedOut,
      cleanup: () => {
        clearTimeout(timer);
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      },
    };
  }

  private validateCredentials(cfg: OpenRouterConfig, modelOverride?: string, correlationId?: string): AIProviderError | null {
    if (!cfg.apiKey) {
      return new AIProviderError({
        code: 'MISSING_API_KEY',
        message: 'OPENROUTER_API_KEY is not configured. Set it in friday/.env.',
        correlationId,
        retryable: false,
      });
    }
    const model = (modelOverride || cfg.model || '').trim();
    if (!model) {
      return new AIProviderError({
        code: 'MISSING_MODEL',
        message: 'OPENROUTER_MODEL is not configured. Set it in friday/.env.',
        correlationId,
        retryable: false,
      });
    }
    return null;
  }

  /**
   * Probe OpenRouter /models endpoint to verify connectivity, authentication, and model availability.
   * Uses a short-lived cache unless forceRefresh is true.
   */
  async checkStatus(timeoutMs = 5_000, options?: { forceRefresh?: boolean }): Promise<AIProviderStatus> {
    const cfg = this.getConfig();
    const correlationId = uuidv4();
    const credErr = this.validateCredentials(cfg, undefined, correlationId);
    if (credErr) {
      this.lastError = credErr.message;
      return {
        provider: this.name,
        configured: false,
        reachable: false,
        baseUrl: cfg.baseUrl,
        configuredModel: cfg.model,
        availableModels: [],
        modelAvailable: false,
        error: credErr.message,
        errorCode: credErr.code,
      };
    }

    if (
      !options?.forceRefresh &&
      this.cachedStatus &&
      Date.now() < this.cachedStatus.expiresAt &&
      this.cachedStatus.status.configuredModel === cfg.model &&
      this.cachedStatus.status.baseUrl === cfg.baseUrl
    ) {
      return this.cachedStatus.status;
    }

    const circuit = this.getCircuitState();
    if (circuit === 'OPEN') {
      return {
        provider: this.name,
        configured: true,
        reachable: false,
        baseUrl: cfg.baseUrl,
        configuredModel: cfg.model,
        availableModels: [],
        modelAvailable: false,
        error: 'OpenRouter circuit breaker is OPEN after repeated failures; waiting for cooldown.',
        errorCode: 'NETWORK_ERROR',
      };
    }

    const reqSig = this.createRequestSignal(timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(cfg, correlationId),
        signal: reqSig.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        const classified = classifyHttpError(res.status, body, correlationId);
        this.recordFailure(classified.message, classified.retryable);
        const failStatus: AIProviderStatus = {
          provider: this.name,
          configured: true,
          reachable: false,
          baseUrl: cfg.baseUrl,
          configuredModel: cfg.model,
          availableModels: [],
          modelAvailable: false,
          error: classified.message,
          errorCode: classified.code,
        };
        this.cachedStatus = { status: failStatus, expiresAt: Date.now() + 3_000 };
        return failStatus;
      }

      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const availableModels = (data.data || [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const modelAvailable =
        availableModels.length === 0 ? true : availableModels.includes(cfg.model);

      this.recordSuccess();

      const status: AIProviderStatus = {
        provider: this.name,
        configured: true,
        reachable: true,
        baseUrl: cfg.baseUrl,
        configuredModel: cfg.model,
        availableModels: availableModels.slice(0, 50),
        modelAvailable,
        ...(modelAvailable
          ? {}
          : {
              error: `Configured model "${cfg.model}" is not available on OpenRouter.`,
              errorCode: 'MODEL_OR_ENDPOINT_NOT_FOUND',
            }),
      };
      this.cachedStatus = { status, expiresAt: Date.now() + HEALTH_CACHE_TTL_MS };
      return status;
    } catch (err) {
      const msg = reqSig.wasTimeout()
        ? `OpenRouter status check timed out after ${timeoutMs}ms`
        : redactProviderSecrets((err as Error).message || 'OpenRouter status check failed');
      this.recordFailure(msg, true);
      return {
        provider: this.name,
        configured: true,
        reachable: false,
        baseUrl: cfg.baseUrl,
        configuredModel: cfg.model,
        availableModels: [],
        modelAvailable: false,
        error: msg,
        errorCode: reqSig.wasTimeout() ? 'TIMEOUT' : 'NETWORK_ERROR',
      };
    } finally {
      reqSig.cleanup();
    }
  }

  async getDiagnostics(timeoutMs = 5_000): Promise<AIProviderDiagnostics> {
    const status = await this.checkStatus(timeoutMs, { forceRefresh: true });
    return {
      ...status,
      lastLatencyMs: this.lastLatencyMs,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      totalRequests: this.totalRequests,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      processRssMb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10,
    };
  }

  /**
   * Execute a non-streaming chat completion request against OpenRouter /chat/completions.
   */
  async chat(request: AICompletionRequest): Promise<AICompletionResponse> {
    const cfg = this.getConfig();
    const correlationId = request.correlationId || uuidv4();
    const started = Date.now();

    const credErr = this.validateCredentials(cfg, request.model, correlationId);
    if (credErr) {
      return {
        ok: false,
        content: '',
        toolCalls: [],
        latencyMs: Date.now() - started,
        correlationId,
        error: credErr.message,
        errorCode: credErr.code,
      };
    }

    const model = (request.model || cfg.model).trim();
    const timeoutMs = request.timeoutMs ?? cfg.timeoutMs;
    const maxAttempts = cfg.maxRetries + 1;
    const endpoint = `${cfg.baseUrl}/chat/completions`;

    const circuit = this.getCircuitState();
    if (circuit === 'OPEN' || (circuit === 'HALF_OPEN' && this.halfOpenProbeInFlight)) {
      return {
        ok: false,
        content: '',
        toolCalls: [],
        latencyMs: Date.now() - started,
        correlationId,
        error: 'OpenRouter circuit breaker is OPEN; skipping request until cooldown elapses.',
        errorCode: 'NETWORK_ERROR',
      };
    }
    if (circuit === 'HALF_OPEN') {
      this.halfOpenProbeInFlight = true;
    }

    const payload: Record<string, unknown> = {
      model,
      messages: request.messages,
      stream: false,
    };
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools;
      if (request.toolChoice) {
        payload.tool_choice = request.toolChoice;
      }
    }
    if (request.responseFormat) {
      payload.response_format = request.responseFormat;
    }
    if (typeof request.temperature === 'number') {
      payload.temperature = request.temperature;
    }
    if (typeof request.maxTokens === 'number') {
      payload.max_tokens = request.maxTokens;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reqSig = this.createRequestSignal(timeoutMs, request.signal);
      try {
        this.totalRequests++;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: this.buildHeaders(cfg, correlationId),
          signal: reqSig.signal,
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errText = await res.text();
          const classified = classifyHttpError(res.status, errText, correlationId);
          this.recordFailure(classified.message, classified.retryable);

          if (classified.retryable && attempt < maxAttempts) {
            const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
            const backoffMs = retryAfterMs ?? Math.min(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250), 10_000);
            log.warn('Retrying OpenRouter request', {
              correlationId,
              attempt,
              statusCode: res.status,
              backoffMs,
            });
            await sleep(backoffMs);
            continue;
          }

          return {
            ok: false,
            content: '',
            toolCalls: [],
            latencyMs: Date.now() - started,
            correlationId,
            error: classified.message,
            errorCode: classified.code,
            statusCode: res.status,
          };
        }

        let data: {
          model?: string;
          choices?: Array<{
            finish_reason?: string;
            message?: {
              content?: string | null;
              tool_calls?: Array<{
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string | Record<string, unknown> };
              }>;
            };
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            cost?: number;
          };
        };

        try {
          data = (await res.json()) as typeof data;
        } catch {
          this.consecutiveFailures++;
          this.lastError = 'OpenRouter returned malformed JSON response';
          return {
            ok: false,
            content: '',
            toolCalls: [],
            latencyMs: Date.now() - started,
            correlationId,
            error: this.lastError,
            errorCode: 'MALFORMED_RESPONSE',
          };
        }

        if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
          this.consecutiveFailures++;
          this.lastError = 'OpenRouter response missing choices array';
          return {
            ok: false,
            content: '',
            toolCalls: [],
            latencyMs: Date.now() - started,
            correlationId,
            error: this.lastError,
            errorCode: 'MALFORMED_RESPONSE',
          };
        }

        const choice = data.choices[0];
        const msg = choice?.message;
        const content = typeof msg?.content === 'string' ? msg.content.trim() : '';
        const toolCalls = this.parseToolCalls(msg?.tool_calls || []);

        const usage: AITokenUsage | undefined = data.usage
          ? {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
              estimatedCostUsd: typeof data.usage.cost === 'number' ? data.usage.cost : undefined,
            }
          : undefined;

        if (usage) {
          this.totalPromptTokens += usage.promptTokens;
          this.totalCompletionTokens += usage.completionTokens;
        }

        const latencyMs = Date.now() - started;
        this.lastLatencyMs = latencyMs;
        this.recordSuccess();

        return {
          ok: true,
          content,
          toolCalls,
          finishReason: choice.finish_reason,
          usage,
          model: data.model || model,
          latencyMs,
          correlationId,
        };
      } catch (err) {
        const isCancelled = Boolean(request.signal?.aborted) && !reqSig.wasTimeout();
        const isTimeout = reqSig.wasTimeout() || (err as Error).name === 'TimeoutError';
        const safeMsg = isTimeout
          ? `OpenRouter request timed out after ${timeoutMs}ms`
          : isCancelled
            ? 'OpenRouter request was cancelled'
            : redactProviderSecrets((err as Error).message || 'OpenRouter network failure');

        this.recordFailure(safeMsg, !isCancelled);

        if (!isCancelled && !isTimeout && attempt < maxAttempts) {
          const backoffMs = Math.min(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200), 5_000);
          await sleep(backoffMs);
          continue;
        }

        return {
          ok: false,
          content: '',
          toolCalls: [],
          latencyMs: Date.now() - started,
          correlationId,
          error: safeMsg,
          errorCode: isCancelled ? 'CANCELLED' : isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        };
      } finally {
        reqSig.cleanup();
      }
    }

    return {
      ok: false,
      content: '',
      toolCalls: [],
      latencyMs: Date.now() - started,
      correlationId,
      error: 'OpenRouter request failed after retries',
      errorCode: 'UNKNOWN_ERROR',
    };
  }

  /**
   * Stream a chat completion from OpenRouter (SSE) with real-time chunk reading,
   * cancellation support, and tool-call accumulation.
   */
  async chatStream(request: AIStreamRequest): Promise<AICompletionResponse> {
    const cfg = this.getConfig();
    const correlationId = request.correlationId || uuidv4();
    const started = Date.now();

    const credErr = this.validateCredentials(cfg, request.model, correlationId);
    if (credErr) {
      return {
        ok: false,
        content: '',
        toolCalls: [],
        latencyMs: Date.now() - started,
        correlationId,
        error: credErr.message,
        errorCode: credErr.code,
      };
    }

    const model = (request.model || cfg.model).trim();
    const timeoutMs = request.timeoutMs ?? cfg.timeoutMs;
    const endpoint = `${cfg.baseUrl}/chat/completions`;
    const reqSig = this.createRequestSignal(timeoutMs, request.signal);

    try {
      this.totalRequests++;
      const payload: Record<string, unknown> = {
        model,
        messages: request.messages,
        stream: true,
      };
      if (request.tools && request.tools.length > 0) {
        payload.tools = request.tools;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: this.buildHeaders(cfg, correlationId),
        signal: reqSig.signal,
        body: JSON.stringify(payload),
      });

      if (!res.ok || !res.body) {
        const errText = res.ok ? 'Empty response body' : await res.text();
        const classified = res.ok
          ? new AIProviderError({ code: 'MALFORMED_RESPONSE', message: 'OpenRouter stream returned empty body', correlationId })
          : classifyHttpError(res.status, errText, correlationId);
        this.consecutiveFailures++;
        this.lastError = classified.message;
        return {
          ok: false,
          content: '',
          toolCalls: [],
          latencyMs: Date.now() - started,
          correlationId,
          error: classified.message,
          errorCode: classified.code,
          statusCode: res.ok ? undefined : res.status,
        };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      const toolAccum = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':') || trimmed === 'data: [DONE]') continue;
          const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
          try {
            const chunk = JSON.parse(jsonStr) as {
              choices?: Array<{
                finish_reason?: string;
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                message?: { content?: string };
              }>;
            };
            const choice = chunk.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const token = choice?.delta?.content ?? choice?.message?.content ?? '';
            if (token) {
              fullContent += token;
              request.onToken?.(token);
            }
            for (const tc of choice?.delta?.tool_calls || []) {
              const idx = tc.index ?? 0;
              const entry = toolAccum.get(idx) || { id: tc.id || `call_${idx}`, name: '', args: '' };
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
              toolAccum.set(idx, entry);
            }
          } catch {
            // Skip partial or non-JSON SSE lines
          }
        }
      }

      if (buffer.trim() && buffer.trim() !== 'data: [DONE]') {
        const jsonStr = buffer.trim().startsWith('data:') ? buffer.trim().slice(5).trim() : buffer.trim();
        try {
          const chunk = JSON.parse(jsonStr) as {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
          };
          const token = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '';
          if (token) {
            fullContent += token;
            request.onToken?.(token);
          }
        } catch {
          // Ignore trailing non-JSON
        }
      }

      const rawToolCalls = Array.from(toolAccum.values()).map((t) => ({
        id: t.id,
        function: { name: t.name, arguments: t.args },
      }));
      const toolCalls = this.parseToolCalls(rawToolCalls);

      const latencyMs = Date.now() - started;
      this.lastLatencyMs = latencyMs;
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();

      return {
        ok: true,
        content: fullContent.trim(),
        toolCalls,
        finishReason,
        model,
        latencyMs,
        correlationId,
      };
    } catch (err) {
      const isCancelled = Boolean(request.signal?.aborted) && !reqSig.wasTimeout();
      const isTimeout = reqSig.wasTimeout() || (err as Error).name === 'TimeoutError';
      const msg = isTimeout
        ? `OpenRouter stream timed out after ${timeoutMs}ms`
        : isCancelled
          ? 'OpenRouter stream was cancelled'
          : redactProviderSecrets((err as Error).message || 'OpenRouter stream failed');
      this.consecutiveFailures++;
      this.lastError = msg;
      return {
        ok: false,
        content: '',
        toolCalls: [],
        latencyMs: Date.now() - started,
        correlationId,
        error: msg,
        errorCode: isCancelled ? 'CANCELLED' : isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      };
    } finally {
      reqSig.cleanup();
    }
  }

  private parseToolCalls(
    rawCalls: Array<{
      id?: string;
      function?: { name?: string; arguments?: string | Record<string, unknown> };
    }>
  ): AIToolCall[] {
    const toolCalls: AIToolCall[] = [];
    for (const call of rawCalls) {
      const fnName = call.function?.name?.trim();
      if (!fnName) continue;
      let parsedArgs: Record<string, unknown> = {};
      const rawArgs = call.function?.arguments;
      if (typeof rawArgs === 'string') {
        const trimmed = rawArgs.trim();
        if (trimmed) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              parsedArgs = parsed as Record<string, unknown>;
            } else {
              log.warn(`Tool call arguments for ${fnName} must be a JSON object`);
              continue;
            }
          } catch {
            log.warn(`Malformed tool call JSON from model for ${fnName}`);
            continue;
          }
        }
      } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
        parsedArgs = rawArgs;
      }
      toolCalls.push({
        id: call.id || `call_${uuidv4().slice(0, 8)}`,
        name: fnName,
        arguments: parsedArgs,
        rawArguments: typeof rawArgs === 'string' ? rawArgs : undefined,
      });
    }
    return toolCalls;
  }
}

let _provider: OpenRouterProvider | null = null;
export function getOpenRouterProvider(): OpenRouterProvider {
  if (!_provider) {
    _provider = new OpenRouterProvider();
  }
  return _provider;
}

export function resetOpenRouterProvider(): void {
  _provider = null;
}
