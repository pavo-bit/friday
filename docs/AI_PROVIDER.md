# AI Provider Architecture

## Provider Abstraction

All LLM inference in FRIDAY routes through `AIProvider` (`friday/src/ai/providers/AIProvider.ts`), implemented by `OpenRouterProvider` (`friday/src/ai/providers/OpenRouterProvider.ts`).

### Capabilities
- Standard chat completions (`POST /chat/completions`)
- Real-time SSE streaming (`chatStream`) with `AbortSignal` cancellation and timeout management
- OpenAI-compatible function/tool calling with malformed-argument rejection
- Structured output (`response_format`) when supported by the configured model
- Token usage and cost tracking (`AITokenUsage`)
- Correlation IDs (`X-Correlation-ID`) and latency diagnostics (`GET /friday/ai/status`)

### Error Handling & Retries
Errors are classified in `friday/src/ai/errors/AIProviderErrors.ts`:
- `401` -> `INVALID_CREDENTIALS` (no retry)
- `402` -> `INSUFFICIENT_CREDITS` (no retry)
- `403` -> `PERMISSION_DENIED` (no retry)
- `404` -> `MODEL_OR_ENDPOINT_NOT_FOUND` (no retry)
- `429` -> `RATE_LIMITED` (bounded retry with `Retry-After` + jitter)
- `5xx` -> `SERVER_ERROR` (bounded exponential backoff + jitter)
- `400` context length -> `CONTEXT_OVERFLOW` (triggers `reduceMessagesForOverflow`)
- Timeouts / aborts -> `TIMEOUT` / `CANCELLED`
