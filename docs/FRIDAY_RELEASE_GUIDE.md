# FRIDAY — Canonical Release & Operations Guide

## 1. System Architecture
- **Backend (`friday/`):** TypeScript + Node.js Express + WebSocket (`ws`) + SQLite (`better-sqlite3`, WAL mode, transactional migrations v1–v7).
  - **Orchestration:** `CapabilityRegistry` → `CapabilityDiscoveryEngine` → `ToolPlanner` → `BackgroundOrchestrator` → `ResultVerifier` → `DisplayManager`.
  - **Security:** `SafetyGate` + `ApprovalStore` (SQLite-bound single-use SHA-256 action/argument-hashed approvals), `AuthService` (per-device pairing codes, SHA-256 `frd_` tokens, expiry & revocation), `Origin` + Bearer auth on HTTP & `/friday/ws` with per-actor event isolation.
  - **Modules:** Financial Intelligence (`src/finance/`, integer minor-unit math) & Trading Copilot (`src/trading/`, NSE/BSE cash-equity analysis, risk sizing, backtesting; no autonomous order execution).
- **Desktop UI (`friday/ui/`):** Dark navy & cyan JARVIS dashboard served at `http://127.0.0.1:3141` with Command Center, Financial Intelligence, Trading Copilot, Monitoring, Reminders, Notifications, Memory, Voice, and Settings.
- **Android Companion (`friday_companion/`):** Flutter + Riverpod + GoRouter + Dio + `IOWebSocketChannel` + `FlutterSecureStorage` (Android Keystore) + `sqflite` offline cache + native Kotlin `ScreenShareForegroundService` (`MediaProjection`).

## 2. Setup & Startup (Windows + Local Ollama)
1. **Prerequisites:** Node.js 20+, npm, Ollama (`ollama serve` + `ollama pull qwen3:4b`), and Flutter 3.x (for Android companion).
2. **Backend Startup:**
   ```powershell
   cd friday
   npm install
   npm run build
   npm start
   ```
3. **Desktop Dashboard:** Open `http://127.0.0.1:3141` in a browser.

## 3. Secure Pairing & Private Remote Access (Tailscale / WireGuard)
1. Never expose port `3141` to the public internet. Bind to localhost or your private Tailscale/WireGuard interface.
2. In the Desktop Dashboard (**Settings & Security**), click **Generate Pairing Code** (valid for 5 minutes).
3. In the Android Companion, enter the laptop's LAN or Tailscale IP (`http://100.x.x.x:3141`) and the 6-digit code.
4. The companion stores the `frd_...` Bearer token in Android Keystore (`FlutterSecureStorage`) and authenticates `/friday/ws` via the `Authorization: Bearer` header (never URL query strings).

## 4. Task Lifecycle & Presentation Contract
`RECEIVED` → `QUEUED` → `RUNNING` → (`WAITING_FOR_APPROVAL` if high-risk) → `VERIFYING` → (`PRESENTING` WebSocket progress event) → `COMPLETED` (or `FAILED` / `CANCELLED` / `TIMED_OUT` / `INTERRUPTED`).
*Note:* SQLite `background_tasks.status` transitions `VERIFYING → COMPLETED` to preserve the v3 `CHECK` constraint without destructive table rebuilds; `PRESENTING` is published as a live lifecycle event while `DisplayManager` persists to `presentations`.

## 5. Android Permissions & Explicit Screen Sharing
- **Microphone:** Used only when voice input is triggered.
- **Notification Access:** Disabled by default; metadata-only unless separate content opt-in is enabled.
- **MediaProjection Screen Sharing:** Starts **only** on manual user action + Android system consent dialog, runs `ScreenShareForegroundService` with `foregroundServiceType="mediaProjection"` and a persistent **Stop Sharing** notification, and never auto-restarts.

## 6. Backup & Recovery
- **Create Verified Backup:** `POST /friday/backup` (or **Settings & Security → Backup Database**). Uses SQLite's online `backup()` API and verifies `PRAGMA integrity_check === 'ok'`.
- **Restore:** `MemoryStore.restoreDatabase(backupPath)` verifies the backup's integrity first, saves a `.pre-restore-<timestamp>.bak` safety copy of the active database, and restores atomically. Corrupted backups are rejected.

## 7. Known Limitations
1. **No Live Broker / Bank Connectors:** Financial Intelligence uses `USER_ENTERED` records and Trading Copilot uses `HISTORICAL_FIXTURE` or user-supplied candles; live NSE/BSE feeds and bank APIs are not connected.
2. **Android Physical Hardware:** Kotlin `MediaProjection` service and `AndroidManifest.xml` compile checks are included, but physical Android device testing of `ScreenShareForegroundService` is required before store distribution.
3. **Localhost Mode:** Direct `127.0.0.1` connections on the laptop operate as `local` unless `FRIDAY_REQUIRE_WS_AUTH=true` is set.
