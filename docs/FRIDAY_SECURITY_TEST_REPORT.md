# FRIDAY — Security Test Report (WP1)

**Test Suite:** `friday/tests/securityHardeningWP1.test.mjs`  
**Status:** Verified as part of `npm test`

## Coverage
- Malformed (`Basic`) and invalid (`Bearer`) tokens rejected with **HTTP 401** across `/friday/identity`, `/friday/identity/projects`, `/friday/learning/records`, `/friday/research/jobs`, and `/friday/personality`.
- Revoked device tokens rejected immediately with **HTTP 401**.
- Remote actor-ID spoofing (`local` or another device ID) rejected with `ActorImpersonationError` (**HTTP 403**).
- Cross-device isolation verified on learning record retrieval and deletion.
- Bound approval ownership, cross-actor rejection, and replay prevention verified via `SafetyGate`.
- SSRF protection verified for `127.0.0.1`, `10.0.0.1`, `172.16.5.4`, `192.168.1.10`, `169.254.169.254`, `::1`, `fe80::1`, `localhost`, and redirect-hop destination validation.
