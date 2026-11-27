// ============================================================
// FRIDAY — Local Ollama Client
// Structured tool calling, health checks, and safe retries
// ============================================================

import { getConfig } from '../shared/config';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('Ollama');

export interface OllamaToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

export interface OllamaToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaStatus {
  reachable: boolean;
  baseUrl: string;
  configuredModel: string;
  installedModels: string[];
  modelAvailable: boolean;
  error?: string;
}

export interface OllamaDiagnostics extends OllamaStatus {
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  processRssMb: number;
}

export class OllamaClient {
  private lastLatencyMs: number | null = null;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastSuccessAt: string | null = null;

  private getRootUrl(): string {
    const base = getConfig().ollamaBaseUrl || 'http://127.0.0.1:11434/v1';
    return base.replace(/\/v1\/?$/, '');
  }

  /**
   * Probe local Ollama server and check whether configured model is installed.
   */
  async checkStatus(timeoutMs = 2_000): Promise<OllamaStatus> {
    const config = getConfig();
    const rootUrl = this.getRootUrl();
    try {
      const res = await fetch(`${rootUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return {
          reachable: false,
          baseUrl: config.ollamaBaseUrl,
          configuredModel: config.ollamaModel,
          installedModels: [],
          modelAvailable: false,
          error: `HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const installedModels = (data.models || []).map((m) => m.name);
      const modelAvailable = installedModels.some(
        (m) => m === config.ollamaModel || m.startsWith(`${config.ollamaModel}:`)
      );
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();
      return {
        reachable: true,
        baseUrl: config.ollamaBaseUrl,
        configuredModel: config.ollamaModel,
        installedModels,
        modelAvailable,
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = msg;
      return {
        reachable: false,
        baseUrl: config.ollamaBaseUrl,
        configuredModel: config.ollamaModel,
        installedModels: [],
        modelAvailable: false,
        error: msg,
      };
    }
  }

  async getDiagnostics(timeoutMs = 2_000): Promise<OllamaDiagnostics> {
    const status = await this.checkStatus(timeoutMs);
    return {
      ...status,
      lastLatencyMs: this.lastLatencyMs,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      processRssMb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10,
    };
  }

  /**
   * Stream a chat completion from Ollama (OpenAI-compatible SSE) with fallback.
   */
  async chatStream(params: {
    messages: OllamaChatMessage[];
    model?: string;
    timeoutMs?: number;
    onToken?: (token: string) => void;
  }): Promise<{ ok: boolean; content: string; latencyMs: number; error?: string }> {
    const config = getConfig();
    const model = params.model || config.ollamaModel || 'qwen3:4b';
    const timeoutMs = params.timeoutMs ?? 25_000;
    const endpoint = `${this.getRootUrl()}/v1/chat/completions`;
    const started = Date.now();

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          messages: params.messages,
          stream: true,
        }),
      });

      if (!res.ok || !res.body) {
        const errText = res.ok ? 'Empty response body' : await res.text();
        this.consecutiveFailures++;
        this.lastError = `Ollama HTTP ${res.status}: ${errText.slice(0, 160)}`;
        return { ok: false, content: '', latencyMs: Date.now() - started, error: this.lastError };
      }

      const raw = await res.text();
      let fullContent = '';
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
        try {
          const chunk = JSON.parse(jsonStr) as {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
            message?: { content?: string };
          };
          const token =
            chunk.choices?.[0]?.delta?.content ??
            chunk.choices?.[0]?.message?.content ??
            chunk.message?.content ??
            '';
          if (token) {
            fullContent += token;
            params.onToken?.(token);
          }
        } catch {
          // Skip non-JSON SSE lines
        }
      }

      const latencyMs = Date.now() - started;
      this.lastLatencyMs = latencyMs;
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();
      return { ok: true, content: fullContent.trim(), latencyMs };
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError'
        ? `Ollama stream timed out after ${timeoutMs}ms`
        : (err as Error).message;
      this.consecutiveFailures++;
      this.lastError = msg;
      return { ok: false, content: '', latencyMs: Date.now() - started, error: msg };
    }
  }

  /**
   * Send a chat completion request to Ollama with optional structured tools.
   * Handles timeouts, unavailable server, and malformed tool arguments safely.
   */
  async chat(params: {
    messages: OllamaChatMessage[];
    tools?: OllamaToolSchema[];
    model?: string;
    timeoutMs?: number;
  }): Promise<{
    ok: boolean;
    content: string;
    toolCalls: OllamaToolCall[];
    error?: string;
  }> {
    const config = getConfig();
    const model = params.model || config.ollamaModel || 'qwen3:4b';
    const timeoutMs = params.timeoutMs ?? 25_000;
    const endpoint = `${this.getRootUrl()}/v1/chat/completions`;

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            model,
            messages: params.messages,
            tools: params.tools && params.tools.length > 0 ? params.tools : undefined,
            stream: false,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          return {
            ok: false,
            content: '',
            toolCalls: [],
            error: `Ollama HTTP ${res.status}: ${errText.slice(0, 200)}`,
          };
        }

        const data = (await res.json()) as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{
                id?: string;
                function?: { name?: string; arguments?: string | Record<string, unknown> };
              }>;
            };
          }>;
        };

        const msg = data.choices?.[0]?.message;
        const content = (msg?.content || '').trim();
        const rawCalls = msg?.tool_calls || [];
        const toolCalls: OllamaToolCall[] = [];

        for (const call of rawCalls) {
          const fnName = call.function?.name;
          if (!fnName) continue;
          let parsedArgs: Record<string, unknown> = {};
          const rawArgs = call.function?.arguments;
          if (typeof rawArgs === 'string') {
            try {
              parsedArgs = JSON.parse(rawArgs);
            } catch {
              log.warn(`Malformed tool call JSON from model for ${fnName}`);
              continue;
            }
          } else if (rawArgs && typeof rawArgs === 'object') {
            parsedArgs = rawArgs;
          }
          toolCalls.push({
            id: call.id || `call_${Date.now()}`,
            name: fnName,
            arguments: parsedArgs,
          });
        }

        return { ok: true, content, toolCalls };
      } catch (err) {
        const message = (err as Error).message || 'Ollama request failed';
        if (attempt < maxAttempts && !message.includes('ECONNREFUSED')) {
          continue;
        }
        return {
          ok: false,
          content: '',
          toolCalls: [],
          error: message,
        };
      }
    }

    return { ok: false, content: '', toolCalls: [], error: 'Ollama request failed' };
  }
}

let _ollama: OllamaClient | null = null;
export function getOllamaClient(): OllamaClient {
  if (!_ollama) {
    _ollama = new OllamaClient();
  }
  return _ollama;
}
