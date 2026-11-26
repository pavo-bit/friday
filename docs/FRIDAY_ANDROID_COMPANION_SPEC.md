# FRIDAY Android Companion — Implementation Specification

**Status:** Approved implementation baseline  
**Version:** 1.0  
**Repository:** \`pavo-bit/friday\`  
**Branch policy:** \`main\` only  
**Client:** Flutter for Android, with Kotlin platform integrations where Android APIs require them  
**Intelligence host:** Existing FRIDAY TypeScript service + Rust Claw runtime + local Ollama

## 1. Objective

Build an Android companion that securely connects a phone to the user's FRIDAY instance on their Windows laptop. The phone is a permissioned interface and device-signal source, not a second independent assistant.

The laptop remains the primary intelligence host: local Ollama inference (default \`qwen3:4b\`), existing TypeScript API, task router, safety gate, SQLite memory and Rust Claw bridge. No paid model API, mandatory cloud inference or third-party screen-analysis service may be introduced.

Extend the existing FRIDAY systems. Preserve the web dashboard, Rust runtime, TypeScript service, SQLite memory and localhost-first behavior.

## 2. Locked decisions

| Area | Requirement |
|---|---|
| Connectivity | Same-network access and secure remote access when away |
| Screen access | Only during a screen-sharing session explicitly started and approved on the phone |
| Device control | Ask for confirmation before every device action that changes state |
| Inference | Local Ollama on the laptop; no paid API fallback |
| Pairing | QR pairing with confirmation on both devices |
| Trust | Deny by default; scopes independently revocable |
| Exposure | Never expose an unauthenticated FRIDAY API or Ollama port publicly |

Users can disconnect, revoke a device, revoke a permission or stop screen sharing at any time.

## 3. Scope

### Included

1. Secure phone/laptop pairing and device registry.
2. LAN connectivity and private-network remote connectivity.
3. Battery, charging, OS and connection status.
4. Installed-app discovery subject to Android package-visibility rules.
5. Aggregate app usage through Usage Access after user opt-in.
6. Selected notifications through Notification Listener after user opt-in.
7. Launching applications through supported Android launch intents, with confirmation each time.
8. Session-scoped screen sharing through MediaProjection, started by an explicit user gesture and Android consent.
9. Local OCR and local-model interpretation on the laptop.
10. Phone chat, voice entry, task status and approval prompts.
11. Permission/status settings, device revocation and auditable activity history.

### Explicitly excluded from the first release

- Covert or continuous screen recording; silent/background screen capture.
- Hidden microphone/camera activation.
- Reading arbitrary app databases, private app storage, passwords, OTPs or protected content.
- Bypassing Android permission prompts, secure-window restrictions, DRM or app protections.
- Unrestricted remote touch/keyboard control.
- General-purpose Accessibility Service automation used to bypass app controls.
- Sending messages, payments, deleting data or changing account/security settings without explicit confirmation.
- Public API exposure, public port forwarding or cloud AI inference.

## 4. Architecture

\`\`\`text
Android Companion (Flutter + Kotlin platform adapters)
  Chat / voice / device status / app usage / notifications
  Explicit screen-share session / action confirmation
                 |
        Authenticated HTTPS + WSS
        LAN or private remote network
                 |
FRIDAY Device Gateway (module mounted in existing API initially)
  Pairing / device tokens / registry / scopes / validation
  Rate limits / audit events / WebSocket routing
                 |
          Typed internal calls
                 |
Existing FRIDAY Core
  Intent parser / task router / safety gate / SQLite memory
  Rust Claw bridge / local Ollama inference
\`\`\`

The gateway is a logical service boundary and may initially live inside the existing FRIDAY API process with isolated middleware and route modules. Do not create a second assistant runtime or duplicate the task router.

### LAN mode

- Discover or configure the laptop LAN endpoint during explicit pairing.
- The gateway may listen on a LAN interface only when LAN connectivity is enabled.
- Do not change the current default \`FRIDAY_HOST=127.0.0.1\` just to make the phone connect.
- Require TLS and device authentication. Pair/pin a local development certificate and document renewal/trust for production.
- Reject unpaired devices, invalid hosts, expired credentials and replayed challenges.

### Remote mode

- Initial supported transport: private overlay network such as Tailscale or an equivalent user-controlled WireGuard network.
- User enrolls both devices and explicitly enables remote access.
- Private-network membership does not replace app-level device authentication.
- No public port forwarding, unauthenticated relay or public reverse proxy by default.
- If the private route is unavailable, report offline; never fall back to an insecure route.

## 5. Pairing and security

### Pairing flow

1. Laptop dashboard: **Devices → Add phone**.
2. FRIDAY creates a cryptographically random, single-use challenge (recommended lifetime: 2 minutes).
3. QR contains only pairing endpoint, challenge ID and protocol version—not a reusable device token.
4. Phone scans and requests pairing.
5. Both devices display the same short verification phrase/code.
6. User confirms on both devices.
7. Gateway issues a unique device identity and revocable credential.
8. Phone stores its credential using Android Keystore-backed secure storage.
9. Gateway stores a credential verifier/hash where practical, plus device metadata, scopes, timestamps and revocation state.

### Authentication requirements

- High-entropy, device-specific credentials; never share tokens between devices.
- Short-lived access credentials and rotating refresh credentials, or equivalent challenge-based sessions.
- Bind sessions to enrolled device identity; enforce expiry, rotation, revocation and replay protection.
- Never log bearer tokens, QR secrets, screen frames, notification bodies or audio.
- Provide disconnect/revoke controls on phone and laptop.
- Audit pairing and scope changes without storing sensitive payload contents.

### API security

- Explicit schema validation, payload size limits, per-device rate limits and connection limits.
- TLS for LAN and remote sessions.
- Reject unknown message types and unsupported protocol versions.
- Keep Ollama on localhost; phone never connects directly to Ollama.
- No arbitrary shell commands, arbitrary paths, executable code or model-authored commands from phone.
- Use allowlisted typed device actions, never arbitrary command execution.
- CORS is not native-app authentication; native requests must authenticate independently.

## 6. Android permissions and native integrations

Use Flutter for UI/state and a small Kotlin platform layer (MethodChannel/EventChannel or a maintained plugin) for Android services. Do not request every permission at first launch; explain each permission at the moment its feature is enabled.

| Capability | Android mechanism | Consent / policy |
|---|---|---|
| Battery/charging | BatteryManager / broadcasts | Basic status needs no special runtime permission |
| Installed apps | PackageManager | Declare narrow package visibility; avoid broad visibility unless justified |
| App usage | UsageStatsManager | User manually grants Usage Access in Settings |
| Notifications | NotificationListenerService | User enables notification access and selects apps/categories |
| Screen sharing | MediaProjection | In-app start plus Android system consent |
| Launch app | PackageManager launch intent | Confirm every launch request |
| Microphone | Android microphone permission | Capture only during visible, user-started voice session |

### Installed apps

- Follow Android package-visibility rules and document each manifest declaration.
- Do not promise that every installed package is discoverable on every Android version/device.
- Expose only app label, package identifier, icon reference if available and launchability.
- Launch only through a verified supported launch intent.
- If no launch intent exists, explain that the app cannot be launched through this integration.
- Show the target app name and **Confirm launch** before launching.

### App usage

- Use UsageStatsManager only after manual Usage Access grant.
- Show permission state and last-updated timestamp.
- Aggregate foreground duration and coarse usage windows on-device.
- Do not stream raw usage events continuously; send summaries only on request or a separately consented feature.
- Handle revoked permission, missing data and Android background restrictions honestly.

### Notifications

- Disabled by default; permission and per-app selection are separate opt-ins.
- Metadata-first; sharing notification bodies is a separate opt-in.
- Provide per-app allow/deny and immediate pause.
- Do not persist notification bodies in FRIDAY memory by default; redact OTP-like content where practical.
- Show clearly when notification access is enabled and provide retention controls.

### Session-scoped screen sharing

- Start only after the user taps **Start screen sharing** and accepts Android's MediaProjection system prompt.
- Show a persistent foreground-service notification with **Stop sharing** while active.
- Stop immediately on user request, permission revocation, session expiry, service shutdown or invalid projection.
- Never auto-restart after reboot, process death or reconnect.
- Send bounded frames only to the authenticated gateway over TLS; remote mode uses the private network.
- On-demand/low-frame-rate capture by default; no continuous full-frame-rate video.
- Keep frames in memory; persist only after an explicit user request and destination confirmation.
- Respect secure-window/DRM restrictions; never bypass them.
- Show an unmistakable active-session indicator on phone and laptop.

### Screen understanding

- Laptop performs OCR and passes relevant extracted text/image context to local Ollama.
- No external vision API.
- Redact known sensitive patterns where practical before any persistence/logging.
- Never add screen contents to long-term memory by default.
- Distinguish visible evidence from assumptions; report unreadable, stale or protected screens honestly.
- User can stop capture immediately.

## 7. Device action policy: confirmation required

The selected policy is **confirm every state-changing device action**.

Read-only queries (battery, permitted app usage, app inventory, connection state, screen explanation during an active session) may run after the relevant permission is granted.

Every state-changing action requires a fresh, explicit confirmation immediately before execution, including:
- Launching an application or opening a deep link.
- Tapping, typing, scrolling or submitting a form if a future supported interaction mechanism is approved.
- Sending a message/email from the phone.
- Changing device/app settings.
- Deleting, moving or modifying phone data.

Confirmation UI must show exact action, target app, parameters/destination, impact, **Confirm** and **Cancel**, plus expiry.

- Silence, dismissal, previous unrelated approval or model-generated text is never approval.
- Approval is single-use and bound to one action payload hash, device, session and expiry.
- Any payload change invalidates approval.
- Cancel, timeout, disconnect or app backgrounding fails closed.
- High-impact actions may require an additional confirmation or remain out of scope.
- Phone-side action confirmation is authoritative on the phone; laptop UI cannot silently approve.

## 8. Proposed API and event contract

The following endpoints/events are proposals, not existing functionality. Implement and document schemas before the mobile app depends on them.

### REST

| Method | Path | Purpose |
|---|---|---|
| POST | \`/friday/devices/pairing-challenges\` | Create short-lived pairing challenge (dashboard-authenticated) |
| POST | \`/friday/devices/pair\` | Complete pairing after dual confirmation |
| GET | \`/friday/devices\` | List paired devices |
| GET | \`/friday/devices/:deviceId\` | Device details and scopes |
| DELETE | \`/friday/devices/:deviceId\` | Revoke device |
| POST | \`/friday/devices/:deviceId/session\` | Create/refresh authenticated session |
| POST | \`/friday/devices/:deviceId/heartbeat\` | Device health/last-seen |
| GET | \`/friday/devices/:deviceId/permissions\` | Read granted companion scopes |
| POST | \`/friday/devices/:deviceId/permissions\` | Update scopes after consent |
| POST | \`/friday/devices/:deviceId/usage-summary\` | Submit consented aggregate usage |
| POST | \`/friday/devices/:deviceId/notifications\` | Submit allowed notification event |
| POST | \`/friday/devices/:deviceId/screen-sessions\` | Create logical session after Android consent |
| DELETE | \`/friday/devices/:deviceId/screen-sessions/:sessionId\` | End session |
| POST | \`/friday/devices/:deviceId/screen-sessions/:sessionId/frames\` | Upload bounded frame during active session |
| POST | \`/friday/devices/:deviceId/actions\` | Request typed phone action |
| POST | \`/friday/devices/:deviceId/actions/:actionId/decision\` | Confirm/cancel one action |

All endpoints require device authentication except challenge creation, which requires dashboard-side authorization. Add exact schemas, status codes, idempotency rules and limits to canonical OpenAPI before implementation.

### WebSocket events

Use a versioned envelope: \`protocolVersion\`, \`messageId\`, \`deviceId\`, \`type\`, \`timestamp\`, typed \`payload\`.

Initial events:
- \`device.connected\`, \`device.disconnected\`, \`device.status.updated\`
- \`device.permissions.updated\`, \`device.usage.summary\`, \`device.notification.received\`
- \`device.screen.session.started\`, \`device.screen.session.stopped\`, \`device.screen.frame.available\`
- \`device.action.requested\`, \`device.action.confirmation_required\`, \`device.action.confirmed\`, \`device.action.cancelled\`, \`device.action.completed\`, \`device.action.failed\`

Validate schemas, authenticate, cap sizes and deduplicate events. Never broadcast one device's private data to another device without explicit authorization.

## 9. SQLite persistence

Use the existing SQLite database and migration approach; do not add a second database for the first release.

Proposed tables (exact DDL is a Phase 1 deliverable):
- \`companion_devices\`: device ID, display name, platform, app version, token verifier, created/last-seen/revoked timestamps and safe connection metadata.
- \`companion_device_scopes\`: device ID, scope, enabled state and grant/revoke timestamps.
- \`companion_pairing_challenges\`: challenge ID, verifier, expiry, used timestamp and confirmation state.
- \`companion_action_requests\`: action/device IDs, typed action, payload hash, risk, state and timestamps.
- \`companion_screen_sessions\`: session/device IDs, start/expiry/stop timestamps, state and stop reason; never raw frames.
- \`companion_audit_events\`: actor/device, event type, safe metadata, timestamp and outcome.

Use foreign keys, indexes, constraints and transactional state transitions. Store token verifiers, not raw tokens. Do not persist notification bodies, frames, recordings or OCR text by default. Add retention/purge behavior, versioned migrations and migration tests. Revocation invalidates sessions and pending actions.

## 10. Flutter app structure

\`\`\`text
android-companion/
  README.md
  pubspec.yaml
  lib/
    main.dart
    app/ (app shell, router, theme)
    core/ (config, networking, auth, permissions, models, storage)
    features/
      pairing/ conversation/ voice/ devices/ app_usage/
      notifications/ screen_sharing/ action_approval/ settings/
    shared/ (widgets, services)
  android/app/src/main/
    AndroidManifest.xml
    kotlin/.../
      MainActivity.kt
      usage/ notifications/ screen/ apps/ device/
  test/
  integration_test/
\`\`\`

Choose one consistent state-management solution (Riverpod or Bloc), typed API clients, repository boundaries, secure token storage and redacted structured logging. No secrets in source control.

### Required screens

1. Splash/startup and privacy explanation.
2. QR pairing and verification.
3. Connection status (LAN / remote / offline).
4. Home command center and conversation.
5. Voice session.
6. Device overview (battery, OS, connection).
7. App usage and permission status.
8. Notification access and per-app controls.
9. Screen-sharing session with persistent state and Stop.
10. Pending action confirmation.
11. Activity/audit history.
12. Settings, privacy, retention, permissions and disconnect/revoke.

### UX

- Match FRIDAY's dark navy/cyan visual language; preserve readability/accessibility.
- Show connection and last successful sync.
- Explain every permission and how to revoke it.
- Never show a permission as active until Android reports it granted.
- Show visible screen-sharing status and always-available stop.
- Confirmation copy must describe the exact action.
- Include loading, empty, offline, denied and unsupported states.
- No mock device data in production.

## 11. Laptop dashboard integration

Add a **Devices** section without replacing the current chatbox or command center:
- Pair new device with QR challenge.
- List devices, online/offline, last seen, connection and app version.
- Show each permission scope separately.
- Disconnect/revoke device.
- Show active screen-share state and emergency stop.
- Show pending action requests and outcomes.
- Show usage/notification summaries only when enabled.
- Keep private device content out of general logs.

Both clients use the same FRIDAY core and device registry.

## 12. Phased implementation and exit criteria

### Phase 0 — Baseline and design freeze
Re-audit main; preserve user changes; confirm API host defaults, route/WebSocket lifecycle and SQLite migrations; finalize threat model, schemas and permission inventory.
**Exit:** architecture reviewed; existing FRIDAY flows unchanged.

### Phase 1 — Identity and pairing
Gateway module, pairing challenge, device registry, SQLite migrations, revoke endpoints, authenticated WebSocket, Flutter skeleton, QR verification and secure credential storage.
**Acceptance:** LAN pairing works; expired/replayed/unpaired/revoked credentials rejected; revoke kills active sessions; no raw token in logs/database; pairing survives restart.

### Phase 2 — Remote connectivity
Private-network setup, explicit LAN/remote endpoint config, TLS, device authentication, reconnect/offline state.
**Acceptance:** LAN and private remote access work; untrusted public access is rejected; no public Ollama or unauthenticated listener.

### Phase 3 — Read-only device awareness
Battery, app inventory, Usage Access, aggregated usage, Notification Listener, per-app selection and revocation handling.
**Acceptance:** collection disabled until consent; revocation stops collection; usage is aggregated; notification bodies not retained by default; all data is timestamped and real.

### Phase 4 — Confirmed app launching
Typed \`launch_app\` schema, verified package/launch intent, exact phone confirmation, one-time execution and audit.
**Acceptance:** no launch without fresh matching approval; cancel/timeout/replay/altered payload fails; unsupported packages fail safely.

### Phase 5 — Screen understanding
MediaProjection consent and foreground notification, session lifecycle, bounded frame transfer, local OCR/local model, redaction and no-retention defaults.
**Acceptance:** no capture without consent; no auto-restart; stop halts delivery; expired/revoked sessions reject frames; no default frame/OCR persistence; protected content is reported honestly.

### Phase 6 — Hardening and release
Unit/API/WebSocket/Flutter/integration/security tests; builds; physical-device verification; setup/privacy/troubleshooting docs.
**Exit:** critical acceptance tests pass, no unresolved critical/high security issue, Android version limits documented.

## 13. Minimum test matrix

1. Pairing challenge expires and is single-use.
2. Pairing requires confirmation on both devices.
3. Incorrect verification phrase is rejected.
4. Revoked device cannot reconnect.
5. LAN and remote sessions require TLS and device authentication.
6. Public unauthenticated access is rejected.
7. Denied/revoked permissions do not leak data.
8. Usage summary unavailable before Usage Access.
9. Notifications unavailable before access and app selection.
10. Screen capture requires user gesture and Android consent.
11. Screen capture stops on user action, expiry, revoke and disconnect.
12. Frames rejected outside an active session.
13. Launch cannot execute without matching one-time confirmation.
14. Cancelled, expired, replayed or modified approval fails closed.
15. Device A cannot read Device B data.
16. No token, notification body, frame or OCR text appears in logs.
17. App handles laptop offline/restart and network changes.
18. Existing FRIDAY chat, memory, health, approvals and Claw execution remain functional.

## 14. Operations and privacy

- Companion is optional; FRIDAY works with no phone paired.
- Ollama remains local and inaccessible directly from phone.
- No external telemetry/analytics carrying user data.
- Redact credentials and personal content from logs/crash reports.
- Provide export/delete for device metadata and audit history.
- Document Android limits for background activity, package visibility, notification access and protected-screen capture.
- Never promise continuous monitoring where Android does not permit it.
- Remote access requires laptop awake, FRIDAY running and private network available.
- Document narrow Windows firewall rules; never tell users to disable the firewall globally.

## 15. Repository delivery rules

- Work on existing \`main\` only; never create branches or force-push.
- Before each write, fetch current main head and use expected-SHA updates to avoid overwriting concurrent work.
- Preserve all existing runtime behavior and files; do not replace Rust Claw or the current FRIDAY API.
- Add Flutter under \`android-companion/\` unless a later audit finds a better existing mobile workspace.
- Keep endpoint contracts in \`friday/OPENAPI.md\` (or a generated canonical OpenAPI source if introduced).
- Add migrations, tests and docs with each phase; a UI mock is not a completed feature.
- Do not claim physical-device, Android background, LAN or remote tests unless actually run.
- Report each feature as **COMPLETE**, **PARTIAL**, **BLOCKED** or **NOT STARTED**, with test evidence.

## 16. Initial implementation order

Begin with Phase 0 and Phase 1. Do not start screen capture or device-control automation before pairing, authentication, permission scopes, audit logging and confirmation primitives are implemented and tested. Continue in numbered phase order.
