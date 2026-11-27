# FRIDAY — Daily Driver 1.0 Final Release Gate Matrix

**Repository:** `pavo-bit/friday`  
**Branch:** `main`  
**Release Decision:** **DO NOT RELEASE YET — PRIVATE TESTING ONLY** (Automated P0/P1 code & reliability gates PASS; Hardware Gates G2, G4, G5 and 14-day soak G8 remain UNVERIFIED).

| Gate | Description | Status | Evidence / Remaining Blocker |
|---|---|---|---|
| **G0 — Baseline** | Latest `main` code & blockers documented | **PASS** | `FRIDAY_RELEASE_BASELINE.md`, `FRIDAY_RELEASE_VERIFICATION_MATRIX.md`, `FRIDAY_RELEASE_BLOCKERS.md` |
| **G1 — Security** | Auth, actor isolation, approvals, SSRF | **PASS** | `enforceActorScope` on all private routes, `trust proxy = false`, `isLocal` admin guard, `browserAdapter` SSRF + redirect-hop protection, `securityHardeningWP1.test.mjs` |
| **G2 — Local AI (`qwen3:4b`)** | Live Ollama inference & RTX 3050 benchmarks | **UNVERIFIED** | **Blocker:** Ollama not installed/running on workstation during session; verified via mock HTTP/SSE + offline fallback only |
| **G3 — Memory & DB Recovery** | Persistence, isolation, backup/restore | **PASS** | `databaseRecoveryWP3.test.mjs`, `prompt3Reliability.test.mjs` (`verifyBackup`, corrupt backup rejection, restore) |
| **G4 — Windows Voice Hardware** | Physical mic, wake-word, speaker TTS | **UNVERIFIED** | **Blocker:** Audio hardware present (`Realtek` + SAPI voices), but live acoustic mic/speaker test not run |
| **G5 — Android Device QA** | APK install & Galaxy M35 pairing/sync | **UNVERIFIED** | **Blocker:** `app-debug.apk` built cleanly (`130.0s`) and `flutter test` 11/11 passed, but no physical Galaxy M35 connected |
| **G6 — Reliability & Recovery** | Crash recovery, idempotency, quiet hours, leak check | **PASS (Automated)** | `prompt3Reliability.test.mjs` (idempotency, quiet-hours suppression, 150-cycle bounded memory test) |
| **G7 — Regression Suite** | Full backend + Flutter test suites | **PASS** | Backend `npm test` + Flutter `flutter test` (11/11) passing |
| **G8 — 14-Day Soak** | Two weeks of daily usage without critical failures | **NOT STARTED** | Blocked until G2, G4, and G5 pass |
| **G9 — Release Packaging** | Install, backup/restore, operational runbooks | **PASS (Docs)** | `FRIDAY_WINDOWS_QA.md`, `FRIDAY_ANDROID_QA.md`, `FRIDAY_BACKUP_RESTORE_RUNBOOK.md`, `FRIDAY_OPERATIONAL_RUNBOOK.md` |
