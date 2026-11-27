// ============================================================
// FRIDAY — AI Provider Abstraction
// Provider-agnostic typed interfaces for LLM inference
// ============================================================

import { AIErrorCode } from '../errors/AIProviderErrors';

export type AIMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AIToolCallPayload {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AIChatMessage {
  role: AIMessageRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: AIToolCallPayload[];
}

export interface AIToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}

export interface AIToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AITokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export interface AIModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  maxContextTokens?: number;
}

export interface AIProviderStatus {
  provider: string;
  configured: boolean;
  reachable: boolean;
  baseUrl: string;
  configuredModel: string;
  availableModels: string[];
  modelAvailable: boolean;
  error?: string;
  errorCode?: AIErrorCode;
}

export interface AIProviderDiagnostics extends AIProviderStatus {
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  processRssMb: number;
}

export interface AICompletionRequest {
  messages: AIChatMessage[];
  model?: string;
  tools?: AIToolSchema[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  responseFormat?: { type: 'json_object' | 'text' };
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  correlationId?: string;
}

export interface AICompletionResponse {
  ok: boolean;
  content: string;
  toolCalls: AIToolCall[];
  finishReason?: string;
  usage?: AITokenUsage;
  model?: string;
  latencyMs: number;
  correlationId: string;
  error?: string;
  errorCode?: AIErrorCode;
  statusCode?: number;
}

export interface AIStreamRequest extends AICompletionRequest {
  onToken?: (token: string) => void;
}

export interface AIProvider {
  readonly name: string;
  checkStatus(timeoutMs?: number): Promise<AIProviderStatus>;
  getDiagnostics(timeoutMs?: number): Promise<AIProviderDiagnostics>;
  chat(request: AICompletionRequest): Promise<AICompletionResponse>;
  chatStream(request: AIStreamRequest): Promise<AICompletionResponse>;
}
