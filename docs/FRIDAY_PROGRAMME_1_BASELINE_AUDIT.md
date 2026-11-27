# FRIDAY — Programme 1 Baseline Repository Audit
## Intelligence, Web Research, Monitoring & Continuous Learning (Phases 14–16)

**Repository:** `pavo-bit/friday`  
**Branch:** `main`  
**Verified Local HEAD:** `b63418e9f9e1abfc72b3bd1107951dbbe1e462eb` (*feat(identity): Phase 13 expanded - Personal Identity Core, Cross-Project Context, Continuous Learning & Approval-Governed Operator*)  
**Remote `origin/main`:** `f90b62a` (local `main` ahead with Phases 11, 12, and 13 committed locally)  
**Working Tree:** Clean except preserved user modifications (`friday/README.md`, `friday/src/api/routes/trading.ts` if present; currently `git status -s -u` is clean).

---

## 1. Existing Implementations

- **Executive Brain & Orchestration (`friday/src/orchestration/`):**
  - `assistantBrain.ts`: Central `AssistantBrain` orchestrating persistent clarification (`clarificationEngine.ts`), `RequestUnderstandingEngine`, `ContextResolutionEngine`, `CapabilityDiscoveryEngine`, `ToolPlanner`, `BackgroundOrchestrator`, `SafetyGate`, `ResultVerifier`, `ResultSynthesizer`, and Ollama (`qwen3:4b`) chat/tool-calling with offline fallback.
  - `toolRegistry.ts`: Registered capabilities (`core.time.*`, `core.system.*`, `core.monitoring.*`, `core.scheduler.*`, `core.location.*`, `core.notifications.*`) with JSON schema validation, risk levels, permissions, timeouts, and availability probes.
- **Browser / Control (`friday/src/control/controlRouter.ts`):**
  - Only launches local desktop browser (`start "" <url>`) for `OPEN_BROWSER` / `BROWSER_NAVIGATE`. **No headless/HTTP website inspection, multi-page crawling, structured extraction, or research pipeline exists.**
- **Monitoring (`friday/src/services/monitoringEngine.ts` & `notificationService.ts`):**
  - `MonitoringEngine`: Supports persistent SQLite `watchers` with `http_health`, `prometheus`, `grafana`, `json_api`, `postgres` (TCP socket check), and `redis` (TCP socket check), intervals (`5s–24h`), 2-attempt retry with backoff, `failureThreshold`, recovery alerts, and `NotificationService` (`dedupeKey` within 5m).
- **Identity, Projects & Continuous Learning (`friday/src/identity/`, `friday/src/learning/`, `friday/src/memory/`):**
  - SQLite migrations `v1`–`v10` in `migrations.ts`.
  - `PersonalIdentityService`, `ProjectContextService`, `ContinuousLearningEngine`, `sourceValidator.ts`, `identityPolicy.ts`.
  - REST routes `/friday/identity*`, `/friday/learning*`, `/friday/personality*`, `/friday/watchers*`, `/friday/notifications*`.
- **Dashboard (`friday/ui/index.html`, `friday/ui/app.js`):**
  - Tabs for Chat/Execution, Monitoring, Reminders, Notifications, Memory, Finance, Trading, Voice, Settings & Security (with Digital Identity, Personal Identity, Cross-Project Contexts, Learning Activity, and Learned Procedures).
- **Test & Build Status:**
  - `npm run build` (`tsc`) passes cleanly.
  - `npm test` passes **113/113** tests across 15 test files (`30` suites) in `7.38s`.

---

## 2. Partially Implemented & Missing Features

| Area | Current State | Gaps for Programme 1 |
|---|---|---|
| **Phase 14: Web Research & Browser Intelligence** | `controlRouter.ts` only opens a URL in the OS browser; `node-fetch` is installed; no Playwright/Puppeteer dependency. | Missing bounded HTTP/HTML browser adapter, multi-page crawl with depth/domain limits, structured extraction (title, meta, headings, links, pricing, tech indicators), prompt-injection quarantine, multi-domain comparison, Research Engine + SQLite persistence, Executive Brain routing, `core.research.*` capabilities, and Dashboard Web Research tab. |
| **Phase 15: Advanced Monitoring & Proactive Intelligence** | `MonitoringEngine` has basic HTTP/JSON/Prom/Grafana/TCP-Postgres/TCP-Redis checks, `failureThreshold`, and `NotificationService`. | Missing host resource monitors (`cpu_memory`, `disk_usage`, `network`, `app_logs`), explicit `Observation → Suspicion → Verified Incident → Recommendation → Approved Action → Verified Recovery` state machine, latency/error-rate/anomaly tracking, multi-project association (`project_name`), notification preferences (quiet hours, delivery status, ack, retry), and enhanced Dashboard health/incident/recovery views. |
| **Phase 16: Continuous Learning & Knowledge Intelligence** | `ContinuousLearningEngine` (`v10`) has basic `ingest`, `recordCorrection`, `retrieve`, `markStaleRecords`, `proposeProcedure`, `approveProcedure`. | Missing explicit **contradiction detection** (preserving conflicting records instead of silent overwrite), knowledge approval/inspection/deletion APIs, version/correction history, procedure execution history + `SafetyGate`-governed execution (`requires_approval` + `SafetyGate` check), and Dashboard views for contradictions, stale records, source history, and knowledge management. |

---

## 3. Security Concerns & Technical Debt

1. **Untrusted Web Content:** Website HTML/text can contain prompt-injection payloads; must be sanitized via `sanitizeRetrievedText()` and quarantined before entering Executive Brain prompts or `learning_records`.
2. **SSRF / Internal Network Probing in Web Research:** Web Research engine must block `file://`, `javascript:`, `data:`, and private/loopback/metadata IPs unless explicitly permitted for local testing, and must never bypass logins/paywalls or submit forms without approval.
3. **Silent Overwrite of Contradictory Knowledge:** `learningEngine.ts` currently overwrites `learning_records` on `(actor_id, learning_kind, subject, project_name)` conflict; Phase 16 requires recording contradictions explicitly without silent overwrite.
4. **Monitoring Noise vs Verified Incidents:** Single-probe failures must be tracked as `OBSERVATION` / `SUSPICION` before escalating to `VERIFIED_INCIDENT`.

---

## 4. Exact Files to Create / Modify & Implementation Order

1. **Phase 14 (Web Research & Browser Intelligence):**
   - Create `friday/src/research/browserAdapter.ts`, `friday/src/research/researchTypes.ts`, `friday/src/research/researchEngine.ts`, `friday/src/api/routes/research.ts`.
   - Extend `migrations.ts` (`v11`: `research_jobs`, `research_findings`), `toolRegistry.ts` (`core.research.analyze_website`, `core.research.compare_websites`), `requestUnderstanding.ts`, `assistantBrain.ts`, `server.ts`, `ui/index.html`, `ui/app.js`.
   - Test: `friday/tests/webResearch.test.mjs`.
2. **Phase 15 (Advanced Monitoring & Proactive Intelligence):**
   - Extend `migrations.ts` (`v12`: `monitoring_incidents`, `notification_preferences`, `notification_deliveries`, `watchers.project_name` + `watchers.environment`).
   - Extend `monitoringEngine.ts` (system CPU/RAM, disk, network, app logs, `Observation → Suspicion → Verified Incident → Recommendation → Verified Recovery`, latency/error-rate/anomaly, project isolation), `notificationService.ts` (quiet hours, delivery status, ack, retry), `assistant.ts` / monitoring routes, `toolRegistry.ts`, `ui/index.html`, `ui/app.js`.
   - Test: `friday/tests/advancedMonitoring.test.mjs`.
3. **Phase 16 (Continuous Learning & Knowledge Intelligence):**
   - Extend `migrations.ts` (`v13`: `learning_contradictions`, `learning_versions`, `procedure_executions`, `learning_records.approved`, `learning_records.evidence_json`).
   - Extend `learningEngine.ts`, `api/routes/learning.ts`, `assistantBrain.ts`, `ui/index.html`, `ui/app.js`.
   - Test: `friday/tests/continuousLearning.test.mjs`.
4. **Cross-Phase Integration & Documentation:**
   - Wire Research → Learning (approved evidence) and Monitoring → Learning (approved insights) + `docs/PHASE_14_WEB_RESEARCH.md`, `docs/PHASE_15_MONITORING.md`, `docs/PHASE_16_CONTINUOUS_LEARNING.md`, `docs/FRIDAY_PROGRAMME_1_COMPLETION_REPORT.md`.
