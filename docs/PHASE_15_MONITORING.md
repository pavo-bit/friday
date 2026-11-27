# FRIDAY — Phase 15: Advanced Monitoring & Proactive Intelligence

**Status:** Implemented & Tested (`tests/advancedMonitoring.test.mjs`)

## 1. Extended Monitoring Targets ([monitoringEngine.ts](file:///c:/Users/MAYURESH/Desktop/all%20projects/friday/friday/src/services/monitoringEngine.ts))
- Existing targets: `http_health`, `json_api`, `prometheus`, `grafana`, `postgres` (TCP), `redis` (TCP).
- New real adapters added in Phase 15:
  - `cpu_memory` (`system://local`): OS CPU load & RAM utilization via Node `os` module.
  - `disk_usage` (`disk://<path>`): Filesystem capacity utilization via `fs.statfsSync()`.
  - `network` (`network://host:port`): TCP reachability & latency check.
  - `app_logs` (`log://<path>`): Tails local log files and counts `ERROR` / `FATAL` / `EXCEPTION` / `CRITICAL` lines against `metricThreshold`.

## 2. Incident State Machine & Multi-Project Intelligence
- SQLite migration `v12` (`watchers` expanded with `project_name`, `environment`, `latency_threshold_ms`, `actor_id`; added `monitoring_incidents`, `notification_preferences`, `notification_deliveries`).
- Enforces `OBSERVATION → SUSPICION → VERIFIED_INCIDENT → RECOMMENDATION → APPROVED_ACTION → VERIFIED_RECOVERY`:
  - Single failures enter `SUSPICION`; `VERIFIED_INCIDENT` is only triggered once `consecutiveFailures >= failureThreshold`.
  - `approveIncidentAction()` requires `approvedByHuman === true`.
  - Recovery transitions open incidents to `VERIFIED_RECOVERY` and records a verified recovery observation into `ContinuousLearningEngine`.
- Detects slow endpoints (`latencyMs > latencyThresholdMs`) and stale watchers (`last_check_at` older than `max(intervalMs * 3, 180s)`).

## 3. Proactive Notifications & Dashboard
- Extended [notificationService.ts](file:///c:/Users/MAYURESH/Desktop/all%20projects/friday/friday/src/services/notificationService.ts) with quiet hours, `minSeverity`, retryable webhook delivery, delivery status tracking, and acknowledgement.
- Added `/friday/monitoring/overview`, `/friday/monitoring/incidents`, `/friday/monitoring/incidents/:id/acknowledge`, `/friday/monitoring/incidents/:id/approve-action`, and `/friday/notifications/preferences|deliveries|acknowledge` in [assistant.ts](file:///c:/Users/MAYURESH/Desktop/all%20projects/friday/friday/src/api/routes/assistant.ts).
- Updated Monitoring tab in `friday/ui/index.html` and `friday/ui/app.js` with System Health Overview, host CPU/RAM metric, project field, and Incident/Recovery list.
