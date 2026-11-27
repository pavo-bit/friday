# FRIDAY — Daily Driver 1.0 Release Baseline (WP0)

**Repository:** `pavo-bit/friday`  
**Branch:** `main`  
**Verified Local HEAD:** `fd26f2443578cbc38204342a187aa0b509753fc7`  
**Working Tree:** Clean (no unfinished merges, conflicts, or untracked build artifacts).  

---

## 1. Environment & Dependency Baseline
- **Node.js:** `v24.22.1`
- **Backend Dependencies (`friday/package.json`):** `better-sqlite3` `^13.2.0`, `express` `^5.0.1`, `ws` `^8.18.0`, `cors` `^2.8.5`, `dotenv` `^16.4.7`, `node-fetch` `^2.7.0`, `imapflow` `^1.5.0`, `nodemailer` `^9.0.3`, `multer` `^1.4.5-lts.1`, `uuid` `^11.1.0`, `winston` `^3.17.0`, `typescript` `^5.7.3`.
- **SQLite Schema:** Migrations `v1` through `v13` applied transactionally in `friday/src/memory/migrations.ts`.
- **Flutter / Android (`friday_companion/pubspec.yaml`):** Flutter SDK installed at `C:\src\flutter\bin\flutter`, Dart SDK `>=3.3.0 <4.0.0`, `flutter_riverpod`, `go_router`, `dio`, `http`, `web_socket_channel`, `flutter_secure_storage`, `sqflite`, `speech_to_text`, `flutter_tts`.
- **Local Ollama (`qwen3:4b`):** `ollama` CLI not in `PATH` and `127.0.0.1:11434` timed out in this audit environment; validated via mock HTTP/SSE server and offline fallback.

---

## 2. Architecture Summary
- **Entry Point:** `friday/src/index.ts` → `FridayServer` (`friday/src/api/server.ts`)
- **Orchestration:** `AssistantBrain` (`assistantBrain.ts`) → `RequestUnderstandingEngine`, `ContextResolutionEngine`, `ClarificationEngine`, `CapabilityDiscoveryEngine`, `ToolPlanner`, `BackgroundOrchestrator`, `SafetyGate`, `ApprovalStore`, `ResultVerifier`, `ResultSynthesizer`, `OllamaClient`.
- **Domain Engines:** `PersonalIdentityService`, `ProjectContextService`, `AdaptivePersonalityEngine`, `WebResearchEngine`, `IsolatedBrowserAdapter`, `MonitoringEngine`, `NotificationService`, `ContinuousLearningEngine`, Finance & Trading engines, Windows Voice service (`voice/`).
- **Clients:** Web Dashboard (`friday/ui/`), Flutter Android Companion (`friday_companion/lib/`).
- **Current Test Status:** `npm test` passes **143/143** backend tests across 37 suites; `flutter test` passes **11/11** companion tests.
