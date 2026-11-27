# FRIDAY — Phase 14: Web Research & Browser Intelligence

**Status:** Implemented & Tested (`tests/webResearch.test.mjs`)  
**Capabilities:** `core.research.analyze_website`, `core.research.compare_websites`, `core.research.submit_web_action`

## 1. Architecture
- **Browser Adapter ([browserAdapter.ts](file:///c:/Users/MAYURESH/Desktop/all%20projects/friday/friday/src/research/browserAdapter.ts)):**
  - `IsolatedBrowserAdapter` validates public `http://` / `https://` URLs (rejects `file://`, `javascript:`, `data:`, malformed URLs).
  - Enforces bounded multi-page crawl (`maxDepth`, `maxPages`, `sameDomainOnly`, `1.5 MB` body cap, per-page `timeoutMs`, redirect following, and cancellation via `AbortController`).
  - Cleans up `visited` sets, queues, and `AbortController` entries in `finally` blocks (`getActiveSessionCount() === 0`).
  - Respects HTTP `401`/`402`/`403` and paywall/login markers without bypassing access controls.
  - Extracts titles, meta descriptions, headings, links, observable pricing mentions, and strictly observable tech indicators (`X-Powered-By`, `Server`, `<meta name="generator">`, observable asset paths). Never invents missing pricing or tech stack.
  - Sanitizes all extracted text through `sanitizeRetrievedText()` to quarantine prompt-injection attempts.
- **Research Engine ([researchEngine.ts](file:///c:/Users/MAYURESH/Desktop/all%20projects/friday/friday/src/research/researchEngine.ts)):**
  - Implements `User Request → Website Navigation → Evidence Extraction → Validation → Analysis → Research Report`.
  - Persists jobs and findings in SQLite (`v11`: `research_jobs`, `research_findings`) with `actor_id` isolation and evidence deduplication.
  - Distinguishes `facts`, `hypotheses`, and `unknowns`.
- **Executive Brain, API & Dashboard:**
  - `AssistantBrain.matchDirectTool()` routes website analysis and multi-website comparison requests to `analyze_website` and `compare_websites`.
  - REST endpoints in [research.ts](file:///c:/Users/MAYURESH/Desktop/all%20projects/friday/friday/src/api/routes/research.ts): `POST /friday/research/analyze`, `POST /friday/research/compare`, `GET /friday/research/jobs`, `GET /friday/research/jobs/:id`, `POST /friday/research/jobs/:id/cancel`, `POST /friday/research/jobs/:id/save-to-learning`.
  - Dashboard `Web Research` tab in `friday/ui/index.html` and `friday/ui/app.js`.
