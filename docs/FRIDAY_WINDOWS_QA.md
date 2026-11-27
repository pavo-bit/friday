# FRIDAY — Windows 11 Installation, Startup & Voice QA Guide

## 1. Installation & Startup
1. Install **Node.js 20+** (verified on `v24.22.1`) and **Ollama** (`https://ollama.com/download`), then run:
   ```powershell
   ollama pull qwen3:4b
   ```
2. Build and start FRIDAY:
   ```powershell
   cd friday
   npm install
   npm run build
   npm start
   ```
3. Open Dashboard at `http://127.0.0.1:3141`.
4. Optional auto-start on Windows login: toggle in Dashboard → **Voice** tab (`POST /friday/voice/autostart`).

## 2. Windows Voice Hardware QA Checklist (Gate G4 — UNVERIFIED)
- [ ] Verify microphone input permission in Windows Privacy Settings.
- [ ] Speak `"Hey FRIDAY, what time is it?"` and confirm wake-word detection + spoken response via `Realtek High Definition Audio`.
- [ ] Trigger a long explanation and test `Interrupt` (`POST /friday/voice/interrupt`) mid-speech.
- [ ] Test physical `Mute` / `Unmute` and `Sleep` / `Wake` transitions.
