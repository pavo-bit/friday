const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Environment Configuration
// ---------------------------------------------------------------------------
// Load .env file if present (keeps API keys out of shell profile)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
            if (!process.env[key]) process.env[key] = value;
        }
    }
}

// ---------------------------------------------------------------------------
// Express App Setup
// ---------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// This local agent can execute tools on the host. Do not expose its API to
// arbitrary websites or DNS-rebinding hostnames.
app.use((req, res, next) => {
    const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', HOST]);
    if (!allowedHosts.has(req.hostname)) {
        return res.status(403).json({ error: 'FRIDAY dashboard is restricted to localhost.' });
    }
    const origin = req.get('origin');
    if (origin) {
        let originHost;
        try {
            originHost = new URL(origin).hostname;
        } catch {
            return res.status(403).json({ error: 'Invalid request origin.' });
        }
        if (originHost !== req.hostname || !allowedHosts.has(originHost)) {
            return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
        }
    }
    next();
});
app.use(express.json({ limit: '1mb' }));       // Guard against payload abuse
app.use(express.static(__dirname));

const CLAW_RUST_EXE = path.join(__dirname, '..', 'rust', 'target', 'debug', 'claw.exe');
const CLAW_JS = path.join(__dirname, '..', 'rust', 'target', 'debug', 'claw.js');
const CLAW_EXE = fs.existsSync(CLAW_RUST_EXE) ? CLAW_RUST_EXE : CLAW_JS;
const MAX_PROMPT_LENGTH = 32_000;               // Reject absurdly large prompts
const EXECUTION_TIMEOUT_MS = 120_000;           // 2 minute hard limit per request

// ---------------------------------------------------------------------------
// ANSI escape code stripper
// ---------------------------------------------------------------------------
function stripAnsi(text) {
    return text.replace(
        // eslint-disable-next-line no-control-regex
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
        ''
    );
}

// ---------------------------------------------------------------------------
// POST /api/chat  — Main AI endpoint (SECURITY-HARDENED)
// ---------------------------------------------------------------------------
// CRITICAL FIX: Uses execFile() instead of exec().
// execFile() passes arguments as an array directly to the executable,
// completely bypassing the shell. This makes command injection impossible
// regardless of what the user puts in the prompt field.
// ---------------------------------------------------------------------------
app.post('/api/chat', (req, res) => {
    const prompt = req.body.prompt;
    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'No prompt provided' });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
        return res.status(413).json({ error: 'Prompt exceeds maximum length' });
    }

    const env = { ...process.env, HOME: process.env.USERPROFILE };

    // execFile passes ["prompt", <user_input>] directly to the binary.
    // No shell interpretation occurs — the prompt is a raw argv string.
    const isJs = CLAW_EXE.endsWith('.js');
    const bin = isJs ? process.execPath : CLAW_EXE;
    const args = isJs ? [CLAW_EXE, 'prompt', prompt] : ['prompt', prompt];

    execFile(
        bin,
        args,
        { env, timeout: EXECUTION_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
            let output = stdout || '';
            if (stderr) output += '\n' + stderr;
            if (error && !output) output = error.message;

            output = stripAnsi(output);


            res.json({ output: output.trim() });
        }
    );
});

// ---------------------------------------------------------------------------
// GET /api/health  — Quick healthcheck for monitoring
// ---------------------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
    const clawExists = fs.existsSync(CLAW_EXE);
    const openrouterBase = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    const model = process.env.OPENROUTER_MODEL || '';
    const hasKey = Boolean((process.env.OPENROUTER_API_KEY || '').trim());
    let aiOnline = false;
    if (hasKey && model) {
        try {
            const response = await fetch(openrouterBase + '/models', {
                headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
                signal: AbortSignal.timeout(3000)
            });
            if (response.ok) {
                aiOnline = true;
            }
        } catch (_) { /* OpenRouter may be unreachable offline. */ }
    }
    res.json({
        status: clawExists && aiOnline ? 'ok' : 'degraded',
        claw_binary: clawExists,
        ai_provider: 'openrouter',
        ai_configured: hasKey && Boolean(model),
        ai_online: aiOnline,
        ai_url: openrouterBase.replace(/^https?:\/\//, ''),
        model: model || 'unconfigured',
        uptime_seconds: Math.floor(process.uptime()),
    });
});

// ---------------------------------------------------------------------------
// GET /api/sessions  — Observability endpoint (Phase 4 stub)
// ---------------------------------------------------------------------------
app.get('/api/sessions', (_req, res) => {
    // Future: read session JSONL files from the .claw directory
    // and return structured traces for the dashboard.
    const sessionsDir = path.join(__dirname, '..', '.claw', 'sessions');
    if (!fs.existsSync(sessionsDir)) {
        return res.json({ sessions: [], message: 'No sessions directory found' });
    }
    try {
        const files = fs.readdirSync(sessionsDir)
            .filter(f => f.endsWith('.jsonl') || f.endsWith('.json'))
            .map(f => ({
                id: path.basename(f, path.extname(f)),
                file: f,
                size_bytes: fs.statSync(path.join(sessionsDir, f)).size,
                modified: fs.statSync(path.join(sessionsDir, f)).mtime,
            }))
            .sort((a, b) => new Date(b.modified) - new Date(a.modified));
        res.json({ sessions: files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------
app.listen(PORT, HOST, () => {
    console.log(`🚀 FRIDAY dashboard running on http://${HOST}:${PORT}`);
    console.log(`   Binary: ${CLAW_EXE}`);
    console.log(`   Binary exists: ${fs.existsSync(CLAW_EXE)}`);
});

module.exports = app;
