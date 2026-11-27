# OpenRouter Setup Guide

## Environment Variables

Configure these variables in `friday/.env` (never commit `.env` to Git):

```env
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=
OPENROUTER_APP_NAME=FRIDAY
OPENROUTER_TIMEOUT_MS=60000
OPENROUTER_MAX_RETRIES=2
```

## Notes
- `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are validated at startup by `validateConfig()` (`friday/src/shared/config.ts`).
- FRIDAY never hardcodes API keys or falls back to local Ollama.
- Credentials remain strictly on the backend and are never exposed to `friday/ui/`, `web-ui/`, or `friday_companion/`.
- Verify connectivity via `GET /friday/ai/status` or `GET /friday/health`.
