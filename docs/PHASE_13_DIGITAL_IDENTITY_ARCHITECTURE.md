# FRIDAY — Phase 13.0 Architecture Audit & Design
## Digital Identity Core, Adaptive Personality & Natural Conversation Engine

**Repository:** `pavo-bit/friday`  
**Branch:** `main`  
**Local HEAD:** `7625632`  
**Remote `origin/main`:** `f90b62a`  

---

## 1. Repository & Git State Audit

### Remote vs Local `main` Discrepancy
- **Remote `origin/main`** is at `f90b62a` (*Phase 10.1: Persistent SQLite-backed clarification engine and restart recovery*).
- **Local `main`** is **2 commits ahead** of `origin/main`:
  - `f407154`: *Phase 11: Windows Native Voice Activation, Wake-Word Detection & Natural Assistant Experience*
  - `7625632`: *feat(trading): Phase 12 - Advanced Trading Intelligence, NSE/BSE Analysis & Risk-Governed Copilot*
- Both Phase 11 and Phase 12 source files, tests, and documentation are present and passing locally, though not yet pushed to `origin/main`.
- Uncommitted working-tree modifications (`friday/README.md` and `friday/src/api/routes/trading.ts`) are preserved.

---

## 2. Existing Architecture Audit & Reuse Plan

| Existing Module | Current Role | Gaps for Phase 13 | Integration Strategy |
|---|---|---|---|
| `friday/src/orchestration/assistantBrain.ts` | Central Executive Brain orchestrating clarification, understanding, context, discovery, planning, execution, and Ollama fallback. | No personality selection, response-depth selection, or channel-aware (voice vs text) synthesis; `knowledge_question` falls through to legacy parser / Ollama without adaptive persona prompt. | Inject `PersonalityEngine`, `ResponseDepthSelector`, and channel context (`text` / `voice` / `android` / `desktop`) into `process()` without duplicating the Executive Brain. |
| `friday/src/orchestration/requestUnderstanding.ts` | Deterministic NLU extracting entities and 8 `ExecutiveIntentKind` values. | Lacks nuanced conversational intents (`learning_request`, `technical_problem`, `personal_discussion`, `research_request`, `creative_request`, `casual_conversation`, `emotional_support`) and explicit personality/depth override parsing. | Extend `RequestUnderstandingEngine` with `conversationalCategory`, `explicitPersonalityOverride`, `explicitDepthOverride`, `persistPreference`, and `complexity`. |
| `friday/src/orchestration/contextResolution.ts` | Bounded retrieval of recent messages, memories, active tasks, pending approvals, and presentations with injection sanitization. | Does not separate project context, explained concepts, or actor-isolated long-term knowledge; no active topic tracking. | Extend `ContextResolutionEngine` to retrieve categorized memory slices (preferences, project context, explained concepts, long-term knowledge) with provenance & actor isolation. |
| `friday/src/orchestration/resultSynthesizer.ts` | Deterministic synthesis of multi-step task outcomes. | Static template strings; does not adapt tone or voice conciseness. | Keep deterministic verification facts intact while allowing `PersonalityEngine` to adapt framing and voice summary length. |
| `friday/src/orchestration/clarificationEngine.ts` | SQLite-backed persistent clarification state (`v8` migration). | Already persistent and actor/conversation-isolated. | Reuse as-is. |
| `friday/src/intelligence/personality.ts` & `memory/store.ts` | Basic `PersonalityProfile` (`userName`, `formality`, `humor`, `verbosity`, `timezone`) in `personality_profile` table; `memories` and `conversations` tables. | Lacks `ADAPTIVE`, `TEACHER`, `FRIEND`, `COMPANION`, `TECHNICAL_EXPERT`, `PROFESSIONAL_ASSISTANT` profiles, `NATURAL` communication style, `ADAPTIVE` answer detail, temporary overrides, and structured memory categories/conflict resolution. | Create `friday/src/personality/personalityEngine.ts` (and `responseDepth.ts`) re-using `getPersonalityEngine()` compatibility and extending SQLite schema via migration `v9`. |
| `friday/src/orchestration/ollamaClient.ts` | Local Ollama (`qwen3:4b`) chat & structured tool calling with `/api/tags` health check. | Reused as-is; graceful fallback when Ollama is offline. | Pass adaptive system prompt + depth instructions + bounded memory context; measure latency. |
| `friday/src/voice/voiceSessionManager.ts` | Calls `AssistantBrain.process(..., { actorId: 'voice' })` and speaks output via TTS. | Uses generic `voice-*` session IDs and receives full text output even for long explanations. | Pass `channel: 'voice'` and support shared/continuous conversation ID + concise voice summary with full UI payload. |
| `friday/ui/index.html` & `friday/ui/app.js` | Dashboard with `tab-settings` containing `#personalityForm`. | Only exposes `userName`, `formality`, `humor`, `verbosity`, `timezone`. | Extend `tab-settings` with Phase 13 Digital Identity controls and show active adaptive personality badge in chat/header without clutter. |
| `friday_companion/` (Flutter) | Android companion app connecting via `/friday/run` and `/friday/ws`. | Uses existing `/friday/run` contract. | Maintain backward-compatible `/friday/run` JSON response while enriching with optional `personality` metadata (`activeProfile`, `depth`, `voiceSummary`). |

---

## 3. Phase 13 Architecture Pipeline

```text
User Message (Text / Voice / Desktop / Android)
  │
  ▼
1. Persistent Clarification Check (ClarificationEngine — existing)
  │
  ▼
2. Request Understanding (RequestUnderstandingEngine — extended)
   ├── Conversational Category (learning, technical, personal, research, casual, task, etc.)
   ├── Explicit Personality / Depth Overrides (temporary vs persistent)
   └── Complexity & Confidence Signals
  │
  ▼
3. Context & Memory Resolution (ContextResolutionEngine + MemoryStore — extended)
   ├── Actor-isolated Conversation History (multimodal continuity)
   ├── User Preferences & Corrections
   ├── Project Context & Explained Concepts
   └── Long-Term Knowledge (with provenance, timestamps & secret redaction)
  │
  ▼
4. Adaptive Personality & Depth Selection
   ├── PersonalityEngine (ADAPTIVE | TEACHER | FRIEND | COMPANION | TECHNICAL_EXPERT | PROFESSIONAL_ASSISTANT)
   ├── Blended Profiles (e.g. TEACHER + TECHNICAL_EXPERT)
   └── ResponseDepthSelector (ADAPTIVE -> CONCISE | BALANCED | DETAILED)
  │
  ▼
5. Existing Executive Brain & Policy Gate
   ├── SafetyGate, Auth, Tool Permissions, Financial/Trading Risk Policies (NEVER bypassed)
   ├── CapabilityDiscovery & ToolPlanner / BackgroundOrchestrator
   └── Local Ollama Qwen3:4B Natural Conversation Generation (with graceful offline fallback)
  │
  ▼
6. Output Validation & Multimodal Delivery
   ├── Preserve verified facts vs inferred vs unknown
   └── Full response for Text/UI + concise natural summary for Voice
```

---

## 4. Locked Personality Defaults

| Setting | Required Value |
|---|---|
| Default personality | `ADAPTIVE` |
| Communication style | `NATURAL` (warm, clear, intelligent, conversational) |
| Answer detail | `ADAPTIVE` |
| Personality selection | Automatic |
| Manual personality override | Supported (temporary per-turn/session or persistent via settings/explicit request) |
| Default address | `Boss` |
| Local inference | Ollama `qwen3:4b` |

---

## 5. Security & Policy Invariants

1. **No Policy Bypass:** Personality profiles and response depth instructions **never** override `SafetyGate`, device authentication, bound approvals, capability permissions, data provenance, or Financial/Trading risk limits.
2. **Privacy & Memory Hygiene:** Passwords, tokens, API keys, and sensitive financial balances/P&L are never persisted as ordinary conversational memory.
3. **Actor & Conversation Isolation:** Memory entries, preferences, and temporary overrides are scoped by `actorId` and `conversationId`.
4. **Honesty & Grounding:** FRIDAY never pretends to have human emotions/experiences, never fabricates live data, and distinguishes verified facts from inferences and unknowns.
