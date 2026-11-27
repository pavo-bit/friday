# FRIDAY — Phase 13 Architecture & Design
## Personal Digital Identity, Adaptive Intelligence & Continuous Learning Foundation

**Repository:** `pavo-bit/friday`  
**Branch:** `main`  
**Local HEAD (prior to expanded commit):** `079debc`  
**Remote `origin/main`:** `f90b62a`  

---

## 1. Repository & Git State Audit

### Remote vs Local `main` Discrepancy
- **Remote `origin/main`** is at `f90b62a` (*Phase 10.1: Persistent SQLite-backed clarification engine and restart recovery*).
- **Local `main`** is ahead of `origin/main` with Phase 11 (`f407154`), Phase 12 (`7625632`), and Phase 13 initial (`079debc`) committed locally and verified, though not yet pushed to `origin/main`.
- Uncommitted working-tree modifications (`friday/README.md` and `friday/src/api/routes/trading.ts`) are preserved.

---

## 2. Existing Architecture Audit & Reuse Plan

| Existing Module | Current Role | Phase 13 Integration |
|---|---|---|
| `friday/src/orchestration/assistantBrain.ts` | Central Executive Brain orchestrating clarification, understanding, context, discovery, planning, execution, and Ollama fallback. | Integrates `PersonalIdentityService`, `ProjectContextService`, `AdaptivePersonalityEngine`, `selectResponseDepth()`, and `ContinuousLearningEngine` without duplicating the Executive Brain. |
| `friday/src/orchestration/requestUnderstanding.ts` | Deterministic NLU extracting entities and `ExecutiveIntentKind`. | Adds `conversationalCategory`, `complexity`, `explicitPersonalityOverride`, `explicitDepthOverride`, `persistOverride`, and `projectSwitchTarget`. |
| `friday/src/orchestration/contextResolution.ts` | Bounded retrieval of recent messages, memories, active tasks, pending approvals, and presentations with injection sanitization. | Retrieves actor-isolated preferences, active project context, and continuous learning records (`learning_records`) through `sanitizeRetrievedText()`. |
| `friday/src/memory/migrations.ts` & `store.ts` | SQLite persistence (`v1`–`v8`). | Extended via `v9` (`digital_identity_settings`, `conversation_context_state`, memory provenance) and `v10` (`personal_identities`, `project_contexts`, `learning_records`, `learned_procedures`). |
| `friday/src/orchestration/safetyGate.ts` | Risk-based approval & permission enforcement. | Preserved intact; personality overrides and learned procedures **never** bypass `SafetyGate` or require less than explicit human approval. |
| `friday/src/voice/voiceSessionManager.ts` | Voice pipeline connecting wake word, STT, Executive Brain, and TTS. | Passes `channel: 'voice'` and speaks concise `personalityMeta.voiceSummary` while preserving full UI detail. |

---

## 3. Expanded Phase 13 Architecture Pipeline

```text
User Input (Text | Voice | Desktop | Android)
  │
  ▼
1. Persistent Clarification Check (ClarificationEngine — v8)
  │
  ▼
2. Request Understanding (RequestUnderstandingEngine)
   ├── Conversational Category & Complexity
   ├── Explicit Personality / Depth Overrides (temporary vs persistent)
   └── Project Switch Detection ("switch to my <project> project")
  │
  ▼
3. Personal Identity, Cross-Project & Learning Context
   ├── PersonalIdentityService (preferredAddress, goals, explanationStyle, privacy)
   ├── ProjectContextService (strict actor & project boundary isolation)
   ├── ContextResolutionEngine (categorized memories + learning_records, sanitized)
   └── ContinuousLearningEngine (COLLECT → CLASSIFY → EXTRACT → VALIDATE → STORE → RETRIEVE → EVALUATE)
  │
  ▼
4. Adaptive Personality & Depth Selection
   ├── AdaptivePersonalityEngine (ADAPTIVE | TEACHER | FRIEND | COMPANION | TECHNICAL_EXPERT | PROFESSIONAL_ASSISTANT)
   └── selectResponseDepth (ADAPTIVE → CONCISE | BALANCED | DETAILED)
  │
  ▼
5. Existing Executive Brain, SafetyGate & Ollama Qwen3:4B
   ├── Approval-Governed Operator (learned procedures require explicit human approval)
   ├── SafetyGate, Auth, Tool Permissions, Financial/Trading Risk Policies (NEVER bypassed)
   └── Local Ollama Qwen3:4B (with graceful deterministic offline fallback)
  │
  ▼
6. Multimodal Delivery (Full text for UI/Dashboard + concise voiceSummary for TTS)
```

---

## 4. Locked Product & Personality Defaults

| Setting | Required Value |
|---|---|
| Product direction | Personal Digital Identity |
| Autonomy policy | Approval before consequential actions |
| Learning policy | Continuous learning from approved data (no autonomous weight modification) |
| Default personality | `ADAPTIVE` |
| Communication style | `NATURAL` |
| Answer detail | `ADAPTIVE` |
| Default address | `Boss` |
| Local inference | Ollama `qwen3:4b` |

---

## 5. Security, Privacy & Learning Invariants

1. **No Policy Bypass:** Personality profiles, depth overrides, and learned procedures **never** bypass `SafetyGate`, device auth, bound approvals, or Financial/Trading risk limits.
2. **Untrusted Source Isolation:** External web/directory/app claims pass through `validateLearningSource()` and `sanitizeRetrievedText()`, and **never** silently become `VERIFIED_FACT`.
3. **Human-Only Procedure Approval:** Learned workflows (`learned_procedures`) are created with `requires_approval = 1, approved_by_user = 0` and cannot be approved without `approvedByHuman === true`.
4. **Privacy & Identity Hygiene:** Plaintext credentials, API keys, tokens, and sensitive personal characteristic inferences (religion, caste, medical/psychiatric diagnosis, etc.) are rejected by `identityPolicy.ts`.
5. **Strict Actor & Project Isolation:** All identity profiles, project contexts, learning records, and procedures are scoped by `actor_id`.
