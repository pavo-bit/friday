# FRIDAY — Local Ollama setup

FRIDAY's default agent inference runs through the Rust Claw runtime using a local Ollama server. No Anthropic or OpenAI model API key is required for this default path.

## Windows quick start

1. Install [Ollama for Windows](https://ollama.com/download/windows).
2. Open PowerShell and pull the default model:

   ```powershell
   ollama pull qwen3:4b
   ```

3. From the repository root, build the Rust CLI:

   ```powershell
   cd rust
   cargo build -p rusty-claude-cli
   ```

4. Configure FRIDAY:

   ```powershell
   cd ../friday
   Copy-Item .env.example .env
   ```

   Keep these values in `friday/.env`:

   ```dotenv
   OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
   OLLAMA_MODEL=qwen3:4b
   STT_ENGINE=none
   TTS_ENGINE=none
   ```

5. Build and start the FRIDAY API:

   ```powershell
   npm ci
   npm run build
   npm run dev
   ```

6. In a second PowerShell window, start the dashboard:

   ```powershell
   cd web-ui
   npm install
   Copy-Item .env.example .env
   npm start
   ```

   Open http://127.0.0.1:3000.

## Voice

- **Input:** the dashboard microphone uses the browser Web Speech API. Use Chrome or Edge and allow microphone access. Browser recognition may use an online speech service; it is not guaranteed to work offline.
- **Output:** the dashboard uses the browser SpeechSynthesis API and voices installed by Windows/browser. It requires no paid API key.
- Server-side audio-upload STT is intentionally disabled until a local offline recognizer is integrated.

## Model selection

Set `OLLAMA_MODEL` in `friday/.env` and `web-ui/.env` to a model already pulled in Ollama. The default is `qwen3:4b`. The Rust CLI also accepts `--model <model-name>`.

## Troubleshooting

- Check Ollama: `ollama list`
- Start the server: `ollama serve`
- Verify the OpenAI-compatible endpoint: `http://127.0.0.1:11434/v1`
- If the dashboard reports the Claw binary is missing, run `cargo build -p rusty-claude-cli` from `rust/`.
