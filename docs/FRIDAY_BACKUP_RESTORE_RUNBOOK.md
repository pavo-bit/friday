# FRIDAY — Backup, Restore & Installation Runbook (WP6 & WP7)

## 1. Prerequisites
- **OS:** Windows 11 (x64)
- **Node.js:** `v20+` (verified on `v24.22.1`)
- **Local LLM:** Ollama with `qwen3:4b` (`ollama pull qwen3:4b`)
- **Android Companion (optional):** Flutter `3.x` + Android SDK

## 2. Installation & Startup
```powershell
cd friday
npm install
npm run build
npm start
```
Dashboard opens at `http://127.0.0.1:3141`.

## 3. SQLite Backup & Restore
- **Create Backup:** Click `Create SQLite Backup` in Dashboard → Settings, or `POST http://127.0.0.1:3141/friday/backup` from a local session.
- **Restore from Backup:**
  1. Stop the FRIDAY backend process.
  2. Copy the verified `.db` backup file over your configured `FRIDAY_DB_PATH` (default: `friday/data/friday.db`).
  3. Restart `npm start` (`runMigrations()` validates schema `v1`–`v13` idempotently).
- **Verified in:** `friday/tests/databaseRecoveryWP3.test.mjs` (simulated corruption → restore → identity, projects, and learning verified intact).
