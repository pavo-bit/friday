# FRIDAY — Route Authorization Matrix (WP1)

| Route Group | Endpoints | Auth Required | Actor Scope Enforcement | Local-Only Admin Restriction |
|---|---|---|---|---|
| **Health** | `GET /friday/health`, `GET /friday/status` | Public (local/paired) | N/A | No |
| **Device Pairing** | `POST /friday/auth/pair` | 6-digit one-time code | N/A | No |
| **Pairing Code & Backup** | `POST /friday/auth/pair-code`, `POST /friday/backup` | Yes (`isLocal`) | Local owner | **Yes (`403` remote)** |
| **Executive Brain** | `POST /friday/run`, `GET /friday/conversations*` | Yes (`resolveCallerIdentity`) | `identity.actorId` | No |
| **Identity & Projects** | `/friday/identity*`, `/friday/personality*` | Yes (`resolveActorOrRespond`) | `enforceActorScope` | No |
| **Web Research** | `/friday/research/*` | Yes (`resolveActorOrRespond`) | `enforceActorScope` | No |
| **Continuous Learning** | `/friday/learning/*` | Yes (`resolveActorOrRespond`) | `enforceActorScope` | No |
| **Monitoring & Alerts** | `/friday/watchers*`, `/friday/monitoring/*`, `/friday/notifications/*` | Yes (`resolveActorOrRespond`) | `enforceActorScope` | `approve-action` requires `isLocal` |
| **Approvals & Tasks** | `/friday/approvals*`, `/friday/tasks*` | Yes (`resolveCallerIdentity`) | `actorId` ownership | Bound to owner |
