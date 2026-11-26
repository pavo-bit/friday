# Project Overview: Claw Code, FRIDAY & Web UI

This repository contains a unified local AI ecosystem: a high-performance CLI coding agent harness (**Claw Code**), an intelligent personal assistant system (**FRIDAY**), a command-center web dashboard (**Web UI**), and companion auditing tools.

---

## Repository Structure

```
friday/
├── rust/                    # Claw Code - Rust CLI agent harness with local Ollama runtime
├── friday/                  # FRIDAY - AI assistant system (Express + WebSocket + SQLite)
├── web-ui/                  # Dedicated Web UI dashboard (Express server on port 3000)
├── src/                     # Companion Python audit & reference port workspace
├── tests/                   # Python workspace test and parity validation suite
├── docs/                    # Documentation and container workflows
├── assets/                  # Branding and hero assets
├── Containerfile            # Canonical Docker/Podman container build file
├── README.md               # Main repository documentation
├── USAGE.md                # Claw Code usage and CLI guide
├── PHILOSOPHY.md           # Project philosophy and principles
├── ROADMAP.md              # Development roadmap
└── PARITY.md               # Rust port parity tracking
```

---

## 1. Claw Code (Core Agent Engine)

**Location:** `rust/` directory  
**Language:** Rust (with portable Node.js runtime fallback in `rust/target/debug/claw.js`)  
**Type:** CLI agent harness for AI-powered coding via local Ollama models

### What is Claw Code?

Claw Code is a high-performance Rust implementation of an autonomous CLI agent harness that enables local Ollama models (defaulting to `qwen3:4b`) to inspect codebases, execute terminal commands, edit files, and coordinate development tasks without requiring cloud API keys.

### Key Features

- **Local AI Agent Runtime**: Executes coding and assistant tasks using local Ollama (`http://127.0.0.1:11434`)
- **No Paid API Keys Required**: Zero cloud billing; entirely local inference by default
- **Tool System**: 40+ built-in tools for file operations, shell commands, git, web search, etc.
- **Interactive REPL & One-Shot Mode**: Terminal REPL with tab-completion plus one-shot CLI prompts (`claw prompt "<text>"` / `claw -p "<text>"`)
- **Session Management**: Persistent conversation history with resume capability (`claw --resume <session>`)
- **Permission System**: Granular control over tool access (read-only, workspace-write, full-access)
- **MCP Support**: Model Context Protocol for extensible tool integrations
- **Dual Runtime Architecture**:
  - **Native Rust**: High-performance binary compiled via `cargo build -p rusty-claude-cli`
  - **Portable Runner**: `rust/target/debug/claw.js` runner ready out-of-the-box for environments without native C++/Rust toolchains

### Core Components (Rust Crates)

| Crate | Purpose |
|-------|---------|
| **rusty-claude-cli** | Main CLI binary and REPL |
| **runtime** | Session management, config, permissions, MCP lifecycle |
| **api** | Provider clients (Ollama OpenAI-compatible transport, streaming) |
| **tools** | Tool specifications and execution (bash, files, web, AST) |
| **commands** | Slash command registry and rendering (`/doctor`, `/skills`, `/mcp`) |
| **plugins** | Plugin management and metadata |
| **mock-anthropic-service** | Testing infrastructure |
| **telemetry** | Usage tracking and metrics |
| **compat-harness** | Upstream compatibility testing harness |

---

## 2. FRIDAY (Intelligent Assistant System)

**Location:** `friday/` directory  
**Language:** TypeScript / Node.js (v24+)  
**Type:** Fully Responsive Intelligent Digital Assistant System

### What is FRIDAY?

FRIDAY is a comprehensive AI assistant layered on top of Claw Code. It provides natural language understanding, voice input/output via browser Web Speech APIs, persistent memory management, departmental automation (email, system control), and a real-time web dashboard.

### Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                 Web Dashboard (friday/ui)                   │
│        Live metrics, chat stream, memory inspector          │
└─────────────────────────────────────────────────────────────┘
                              │ HTTP / WebSocket (port 3141)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway (Express)                    │
│        /friday/run, /friday/voice, /friday/health           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 Intelligence Layer (NLU)                    │
│     Pattern-matching intent parser with confidence scores   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Orchestration Layer                       │
│     TaskRouter ──► SafetyGate (Approval & Rate Limiting)    │
│     ClawBridge (Process isolation & ANSI sanitization)      │
└─────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Claw Engine   │  │ Control Layer   │  │ Communication   │
│ Code & analysis │  │ Apps, browser,  │  │ Email (SMTP/    │
│   tasks via CLI │  │ screenshots     │  │ IMAP), WhatsApp │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Memory & Voice Foundations                 │
│      SQLite Store (friday.db) ── Browser Speech APIs        │
└─────────────────────────────────────────────────────────────┘
```

### Key Subsystems

1. **Claw Bridge**:
   - Manages subprocess execution using `child_process.execFile()` for process isolation.
   - Auto-detects compiled Rust binary (`claw.exe`/`claw`) or portable runner (`claw.js`).
   - Strips ANSI escape codes from all outputs.
2. **Communication Department** (`src/departments/communication/`):
   - SMTP & IMAP provider for sending, drafting, and reading emails.
   - Message summarization and translation.
3. **Memory Store** (`src/memory/store.ts`):
   - SQLite persistence via `better-sqlite3` v13+.
   - Stores conversation history, memories, user preferences, and task audits.
4. **Voice Engine**:
   - Zero-cost, zero-key voice powered by standard browser Web Speech & SpeechSynthesis APIs.
5. **Safety Gate** (`src/orchestration/safetyGate.ts`):
   - Three-tier risk classification (`low`, `medium`, `high`).
   - Rate limiting and interactive approval workflows for high-risk operations.

---

## 3. Web UI (Command Center Dashboard)

**Location:** `web-ui/` directory  
**Language:** JavaScript / HTML / CSS (Express)  
**Port:** 3000

A dedicated, lightweight web dashboard for interacting directly with the Claw Code engine:
- Simple, zero-overhead browser interface (`index.html`, `style.css`, `script.js`).
- Integrated status metrics (Ollama status, active model, memory stats).
- Direct prompt input with live streaming output.
- Transcript inspection for past sessions.

---

## 4. Companion Python Workspace

**Location:** `src/` and `tests/` directories  
**Language:** Python 3.10+  
**Role:** Reference implementation, audit helper, and compatibility validation

- **Audit CLI** (`src/main.py`): Commands for parity audits, graph segmentation, and manifest generation.
- **Reference Tools**: Companion implementations of tools, commands, and permission policies.
- **Validation**: Test suites in `tests/` checking behavior across implementations.

---

## 5. Configuration

### FRIDAY Configuration (`friday/.env`)

```dotenv
# Local AI (Ollama; no API key required)
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=qwen3:4b

# Server
FRIDAY_PORT=3141
FRIDAY_HOST=127.0.0.1

# Voice (Browser Web Speech API; no cloud key required)
STT_ENGINE=none
TTS_ENGINE=none
WAKE_WORD=friday

# Memory Database
FRIDAY_DB_PATH=./data/friday.db

# Safety
RATE_LIMIT_PER_MINUTE=30
HIGH_RISK_LIMIT_PER_HOUR=5
REQUIRE_HIGH_RISK_APPROVAL=true
```

### Web UI Configuration (`web-ui/.env`)

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=qwen3:4b
PORT=3000
HOST=127.0.0.1
```

---

## 6. Quick Start & Execution

### 1. Set Up Local Ollama
```powershell
# Install Ollama from https://ollama.com
ollama serve
ollama pull qwen3:4b
```

### 2. Run FRIDAY Assistant
```powershell
cd friday
npm install
npm run build
npm start
```
- **Dashboard UI**: [http://127.0.0.1:3141](http://127.0.0.1:3141)
- **Health Check**: [http://127.0.0.1:3141/friday/health](http://127.0.0.1:3141/friday/health)
- **WebSocket**: `ws://127.0.0.1:3141/friday/ws`

### 3. Run Web UI Dashboard
```powershell
cd web-ui
npm install
npm start
```
- Open [http://127.0.0.1:3000](http://127.0.0.1:3000)

### 4. Build Claw Code Natively (Rust)
```powershell
cd rust
cargo build -p rusty-claude-cli
./target/debug/claw doctor
./target/debug/claw prompt "summarize this repository"
```

---

## 7. Ecosystem & Toolchain

Claw Code and FRIDAY are part of the open-source **UltraWorkers** ecosystem:

- **Claw Code** - Local AI CLI agent harness ([ultraworkers/claw-code](https://github.com/ultraworkers/claw-code))
- **FRIDAY** - User-facing assistant system
- [clawhip](https://github.com/Yeachan-Heo/clawhip) - Event and notification router
- [oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) - Multi-agent coordination
- [oh-my-codex (OmX)](https://github.com/Yeachan-Heo/oh-my-codex) - Workflow layer
- [UltraWorkers Discord](https://discord.gg/5TUQKqFWd)

---

## License & Disclaimer

- Open source under the MIT License.
- This repository does **not** claim ownership of original Claude Code source material.
- Part of the open-source **UltraWorkers** ecosystem.

---

**Last Updated:** November 2026  
**Claw Code Engine:** Local Ollama runtime (`qwen3:4b`)  
**FRIDAY Version:** 1.0.0  
**Web UI Version:** 1.0.0  
