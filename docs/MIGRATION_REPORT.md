# Ollama to OpenRouter Migration Report

## Summary
FRIDAY has been migrated from local Ollama (`127.0.0.1:11434`, `qwen3:4b`) to OpenRouter (`https://openrouter.ai/api/v1`) as its sole LLM inference provider while preserving SQLite memory, Assistant Brain, Executive Brain, ToolRegistry permissions, Voice, Monitoring, and Rust Claw integration.

## Key Changes
- Added `friday/src/ai/` (`AIProvider`, `OpenRouterProvider`, `ai.config.ts`, `ModelRouter.ts`, `MemoryManager.ts`, `AIProviderErrors.ts`).
- Removed `friday/src/orchestration/ollamaClient.ts`.
- Migrated `AssistantBrain`, `CapabilityDiscoveryEngine`, `ToolRegistry`, `AdaptivePersonalityEngine`, `/friday/ai/status`, `/friday/health`, `friday/ui/`, `web-ui/`, `friday_companion/`, and `rust/` Claw runtime to OpenRouter.
- Updated `.env.example` files and secret redaction for `sk-or-v1-*` keys.
- Added `friday/tests/openrouterProvider.test.mjs` and updated mocked integration tests.
