# FRIDAY — Operational & Reliability Runbook

## 1. Crash & Restart Recovery
- **Backend Process:** `boot()` in `friday/src/index.ts` automatically recovers SQLite migrations (`v1`–`v13`), active monitoring watchers (`MonitoringEngine.recoverOnBoot()`), and interrupted background tasks (`BackgroundOrchestrator.recoverOnBoot()` — idempotent steps re-queued, non-idempotent side-effect steps marked interrupted without duplicate execution).
- **Ollama Unavailable / Restart:** `OllamaClient` tracks `consecutiveFailures` and recovers automatically once `http://127.0.0.1:11434/api/tags` responds; while offline, deterministic tools and honest offline fallback remain operational.
- **SQLite Backup & Restore:** `store.backupDatabase()` runs hot backup + `verifyBackup()` (`PRAGMA integrity_check`). Corrupt backups are rejected.

## 2. Monitoring & Notifications
- `MonitoringEngine` enforces `SUSPICION → VERIFIED_INCIDENT → APPROVED_ACTION → VERIFIED_RECOVERY`.
- `NotificationService` enforces `dedupeWindowMs`, quiet hours (`SUPPRESSED_QUIET_HOURS`), critical bypass, and webhook delivery retries (`DELIVERED` / `FAILED`).

## 3. Resource & Memory Leak Baseline
- Verified in `friday/tests/prompt3Reliability.test.mjs`: 150 sustained `RequestUnderstandingEngine` + `ContextResolutionEngine` + `AdaptivePersonalityEngine` + `selectResponseDepth` cycles completed with bounded heap growth (`< 50 MB`) and zero leaked browser/monitoring handles.
