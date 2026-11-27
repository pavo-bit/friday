# FRIDAY — Security Review (WP1)

**Repository:** `pavo-bit/friday`  
**Branch:** `main`  
**Audit Scope:** `authContext.ts`, `server.ts`, `research.ts`, `learning.ts`, `identity.ts`, `assistant.ts`, `browserAdapter.ts`, `safetyGate.ts`

---

## 1. Security Hardening Applied
1. **Strict Actor Scoping (`authContext.ts`):**
   - Added `resolveActorOrRespond()` + `enforceActorScope()` across all private endpoints in `research.ts`, `learning.ts`, `identity.ts`, and `assistant.ts`.
   - Remote paired devices (`!identity.isLocal`) cannot spoof `body.actorId` or `query.actorId` (HTTP 403 `ActorImpersonationError`).
2. **Local-Owner Boundary (`authContext.ts` & `server.ts`):**
   - `app.set('trust proxy', false)` explicitly disables `X-Forwarded-For` IP spoofing.
   - `isLocal` requires `req.socket.remoteAddress` to be loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`).
   - Admin operations (`POST /friday/backup`, `POST /friday/auth/pair-code`, `POST /friday/monitoring/incidents/:id/approve-action`) require `identity.isLocal`.
3. **Approval Governance (`safetyGate.ts` & `approvalStore.ts`):**
   - Bound approvals validate `actorId`, `capabilityId`, argument hash, expiry (`expiresAt`), and single-use consumption (replay prevention).
4. **SSRF & Redirect-Hop Protection (`browserAdapter.ts`):**
   - Blocks `file://`, `javascript:`, `data:`, `localhost`, `.local`, `.internal`, IPv4 loopback/private/link-local/metadata (`169.254.169.254`), and IPv6 local/multicast ranges.
   - Performs DNS-rebinding checks (`dns.lookup(..., { all: true })`) and validates every 3xx redirect hop manually (`redirect: 'manual'`, max 5 hops).
