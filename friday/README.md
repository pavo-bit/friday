# FRIDAY — Local-First Personal AI Assistant

FRIDAY is a persistent, local-first personal AI assistant inspired by JARVIS. It runs locally on Node.js + TypeScript + SQLite and uses **Ollama** (`qwen3:4b` default, `qwen3:8b` configurable) for private local inference — **zero paid API keys required**.

## Architecture & Subsystems

1. **Personality Engine** (`src/intelligence/personality.ts`): Configurable formality, humor, verbosity, timezone-aware greetings, and strict truthfulness rules.
2. **Memory & Context Engine** (`src/memory/store.ts`, `src/memory/migrations.ts`, `src/memory/redaction.ts`): Versioned SQLite migrations, bounded context retrieval, secret redaction, retention pruning, and hot backups.
3. **Typed Tool Registry** (`src/orchestration/toolRegistry.ts`): 18 schema-validated, risk-classified, audited tools including `start_dashboard_watch`, `create_reminder`, `create_alarm`, `check_ollama_status`, `send_notification`, etc.
4. **Dashboard Monitoring Engine** (`src/services/monitoringEngine.ts`): Persistent watchers with real background workers, HTTP/Prometheus/Grafana/JSON/Postgres/Redis probes, retry/backoff, alert deduplication, and restart recovery.
5. **Scheduler, Alarms & Reminders** (`src/services/schedulerService.ts`): One-time, recurring, and geofence-triggered reminders with missed-event recovery.
6. **Location Intelligence** (`src/services/locationService.ts`): Opt-in named geofences (`college`, `home`, etc.) and entry/exit triggers.
7. **Security & Device Pairing** (`src/services/authService.ts`): Localhost/origin validation, 6-digit pairing codes, SHA-256 hashed bearer tokens, token rotation, and audit logs.
8. **Command Center Web Dashboard** (`ui/`): Dark-mode dashboard for chat, monitoring, reminders, notifications, memory, voice, and settings.
9. **Android Companion** (`../friday_companion/`): Flutter mobile app with 12 screens, pairing, voice, geofencing, and offline brain status detection.

## Windows Quick Start

1. **Install Ollama**:
   Download [Ollama for Windows](https://ollama.com/download/windows), then start and pull the default model:
   ```powershell
   ollama serve
   ollama pull qwen3:4b
   ```

2. **Configure & Start FRIDAY**:
   ```powershell
   cd friday
   npm install
   Copy-Item .env.example .env
   npm test
   npm start
   ```
   Open [http://127.0.0.1:3141](http://127.0.0.1:3141).

3. **(Optional) Build Rust Claw Runtime**:
   ```powershell
   cd ../rust
   cargo build -p rusty-claude-cli
   ```
   If Rust/MSVC is not installed on Windows, FRIDAY automatically uses the portable runtime at `rust/target/debug/claw.js`.

## Key API Endpoints

- `POST /friday/run` — Natural-language command & tool execution
- `GET /friday/health`, `GET /friday/ollama/status` — System & Ollama health
- `GET/POST /friday/watchers`, `POST /friday/watchers/:id/{pause,resume,stop}`, `GET /friday/watchers/history`
- `GET/POST/PUT/DELETE /friday/reminders`
- `GET /friday/notifications`, `POST /friday/notifications/{:id/read,read-all}`
- `GET/POST/DELETE /friday/locations`, `POST /friday/locations/geofence`
- `GET/PUT /friday/personality`, `GET /friday/tools`, `GET /friday/audit`, `POST /friday/backup`
- `POST /friday/auth/pair-code`, `POST /friday/auth/pair`, `GET /friday/auth/devices`, `POST /friday/auth/devices/:id/rotate`, `DELETE /friday/auth/devices/:id`
