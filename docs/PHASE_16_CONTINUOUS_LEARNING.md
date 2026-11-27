# FRIDAY — Phase 16: Continuous Learning & Knowledge Intelligence

**Status:** Implemented & Tested (`tests/continuousLearning.test.mjs`)

## 1. Pipeline & Storage ([learningEngine.ts](file:///c:/Users/MAYURESH/Desktop/all%20projects/friday/friday/src/learning/learningEngine.ts))
- Extends the existing SQLite `learning_records` and `learned_procedures` tables via migration `v13`:
  - `learning_contradictions`: preserves conflicting facts without silent overwrite (`OPEN`, `RESOLVED_KEEP_EXISTING`, `RESOLVED_USE_NEW`).
  - `learning_versions`: immutable version/correction history (`previous_content`, `new_content`, `reason`).
  - `procedure_executions`: authorization & execution audit log (`authorized`, `BLOCKED` | `COMPLETED` | `FAILED`).
- **7-Stage Pipeline:** `Approved Source → Ingestion → Extraction → Classification → Validation → Provenance → Storage → Retrieval`.
- Explicit user corrections (`conversation_correction`) update with version history; other conflicting sources record a `learning_contradictions` entry instead of silently overwriting.

## 2. Approval-Governed Procedures & Security
- `proposeProcedure()` stores `sourceRef`, `scope`, `requiredPermissions`, and `approved_by_user = 0`.
- `executeProcedure()` blocks execution unless `proc.approvedByUser === true`, `approvedByHuman === true`, and all `requiredPermissions` are granted.
- Untrusted external content is sanitized via `sanitizeRetrievedText()` and `validateLearningSource()`, and credentials/sensitive inferences are rejected.

## 3. REST APIs & Dashboard
- Extended [learning.ts](file:///c:/Users/MAYURESH/Desktop/all%20projects/friday/friday/src/api/routes/learning.ts) with:
  - `POST /friday/learning/records/:id/approve`, `DELETE /friday/learning/records/:id`
  - `GET /friday/learning/contradictions`, `POST /friday/learning/contradictions/:id/resolve`
  - `GET /friday/learning/records/:id/versions`, `GET /friday/learning/stale`
  - `POST /friday/learning/procedures/:id/execute`
- Updated Settings tab in `friday/ui/index.html` and `friday/ui/app.js` with Knowledge Contradictions (Keep / Use New) and Stale Knowledge panels.
