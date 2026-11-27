# Security & Privacy Boundaries

## Cloud Inference Boundary
- **Backend-Only Credentials**: `OPENROUTER_API_KEY` is read exclusively from backend environment variables (`friday/src/ai/config/ai.config.ts`).
- **Secret Redaction**: `redactSecrets()` (`friday/src/memory/redaction.ts`) and `redactProviderSecrets()` (`friday/src/ai/errors/AIProviderErrors.ts`) scrub `Bearer` tokens, `sk-or-v1-*`, `sk-*`, and credential assignments from logs, errors, and SQLite memory.
- **Untrusted Model Output**: Tool arguments returned by OpenRouter are JSON-parsed defensively, validated against `CapabilitySchema`, and checked by `SafetyGate` and `ToolRegistry` permissions.
- **Approval Controls**: High-risk actions (`run_claw_task`, file deletion, external communications) require explicit human approval; `AssistantBrain` always passes `approvedHighRisk: false` for LLM-proposed tool calls.
- **No Insecure Fallback**: Missing or invalid OpenRouter credentials never silently fall back to Ollama or bypass authentication.
