# FRIDAY Architecture

## Overview

FRIDAY is a TypeScript/Node.js personal AI assistant backed by:
- **OpenRouter API** (`https://openrouter.ai/api/v1`) as the sole LLM inference provider.
- **SQLite** (`friday/data/friday.db`) as the authoritative persistence layer for conversations, memory, tasks, reminders, watchers, approvals, and audit logs.
- **Rust Claw Runtime** (`rust/`) for sandboxed coding and agentic execution via `ClawBridge` (`execFile`).
- **Assistant Brain & Executive Brain** (`friday/src/orchestration/`) for intent understanding, context resolution, capability discovery, tool planning, permission validation, and result synthesis.
- **Voice Layer** (`friday/src/voice/` + browser speech APIs) independent of the LLM provider.
- **Android Companion & Web Dashboards** (`friday_companion/`, `friday/ui/`, `web-ui/`).

## Inference Flow

```text
User / Voice / Android / Web UI
       |
AssistantBrain (Intent -> Clarification -> Context Resolution)
       |
ModelRouter + MemoryManager (Bounded Context + Secret Redaction)
       |
OpenRouterProvider (https://openrouter.ai/api/v1/chat/completions)
       |
ToolRegistry + SafetyGate (Schema Validation + Permission/Approval Checks)
       |
SQLite MemoryStore (Authoritative Persistence + Audit Trail)
```
