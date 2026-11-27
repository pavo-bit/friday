# FRIDAY — Daily Driver 1.0 Release Blockers (WP0)

## P0 Blockers (Must Resolve Before Daily Use)
1. **Inconsistent `enforceActorScope` across private routes (WP1.1):**
   - `research.ts` (all 6 routes), `learning.ts` (`/ingest`, `/correction`, `/procedures*`, `/records/:id/*`, `/contradictions*`, `/stale`), `identity.ts` (`/projects*`), and `assistant.ts` (`/watchers*`, `/monitoring/*`, `/notifications/*`, `/personality*`) either accept `body.actorId` / `query.actorId` without `enforceActorScope()` or omit `resolveCallerIdentity()`.
2. **Approval Authority Verification (WP1.3):**
   - `/friday/learning/procedures/:id/approve`, `/friday/learning/procedures/:id/execute`, `/friday/learning/records/:id/approve`, and `/friday/monitoring/incidents/:id/approve-action` must derive actor ownership from `resolveCallerIdentity()` + `enforceActorScope()` and reject cross-actor or unauthorized approval attempts.
3. **SSRF & Redirect-Hop Validation in `browserAdapter.ts` (WP1.4):**
   - `fetch(..., { redirect: 'follow' })` does not inspect intermediate redirect `Location` URLs.
   - Missing private/loopback/link-local/metadata IPv4 & IPv6 blocking and DNS-rebinding check (`dns.lookup`) for public research targets (with explicit opt-in flag for local unit test mock servers).
4. **Live Ollama `qwen3:4b` Validation on Target Host (WP2):**
   - Ollama daemon is not running in this environment; live `qwen3:4b` load time, first-token latency, tokens/sec, and VRAM/RAM usage must be benchmarked on the target ASUS TUF A15 before G2 passes.

## P1 Blockers (Required Before Full Windows + Android 1.0 Declaration)
5. **Windows Physical Audio Hardware QA (WP4 / G4):** Physical microphone wake-word, speaker TTS, interruption, and device-change testing.
6. **Android Physical Device QA & APK Build (WP5 / G5):** `flutter build apk` + pairing/sync/revocation testing on physical Samsung Galaxy M35.
7. **14-Day Real-World Soak Period (G8):** Two weeks of everyday usage without critical failures.
