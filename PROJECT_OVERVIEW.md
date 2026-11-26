# Project Overview: Claw Code & FRIDAY

This repository contains two major projects that work together to provide AI-powered coding assistance and system control capabilities.

---

## Repository Structure

```
claw-code/
├── rust/                    # Claw Code - Rust CLI agent harness
├── friday/                  # FRIDAY - AI assistant system
├── docs/                    # Documentation
├── assets/                  # Images and media
├── README.md               # Main repository documentation
├── USAGE.md                # Claw Code usage guide
├── PHILOSOPHY.md           # Project philosophy
├── ROADMAP.md              # Development roadmap
└── PARITY.md               # Rust port parity tracking
```

---

## 1. Claw Code (Main Project)

**Location:** `rust/` directory  
**Language:** Rust  
**Type:** CLI agent harness for AI-powered coding

### What is Claw Code?

Claw Code is a high-performance Rust implementation of a CLI agent harness that enables local Ollama models to interact with code, execute commands, and perform development tasks autonomously.

### Key Features

- **AI Agent Runtime**: Execute AI-powered coding tasks through a local Ollama model
- **Tool System**: 40+ built-in tools for file operations, shell commands, git, web search, etc.
- **Interactive REPL**: Rich interactive shell with tab completion and streaming responses
- **Session Management**: Persistent conversation history with resume capability
- **Permission System**: Granular control over tool access (read-only, workspace-write, full-access)
- **MCP Support**: Model Context Protocol for extensible tool integrations
- **Plugin System**: Extensible architecture for custom functionality
- **Local inference**: Ollama at 127.0.0.1:11434; no paid model API key required for FRIDAY's default runtime

### Core Components (Rust Crates)

| Crate | Purpose |
|-------|---------|
| **rusty-claude-cli** | Main CLI binary and REPL |
| **runtime** | Session management, config, permissions, MCP lifecycle |
| **api** | Provider clients, streaming, authentication |
| **tools** | Tool specifications and execution (bash, files, web, etc.) |
| **commands** | Slash command registry and rendering |
| **plugins** | Plugin management and metadata |
| **mock-anthropic-service** | Testing infrastructure |
| **telemetry** | Usage tracking and tracing |
| **compat-harness** | TypeScript compatibility testing |

### Statistics

- **~48,599** lines of Rust code (tracked LOC)
- **9 crates** in workspace
- **40+ tools** exposed
- **292 commits** on main branch
- **Built:** `cargo build --workspace`
- **Binary:** `./target/debug/claw` or `./target/release/claw`

### Quick Start

```bash
cd rust
cargo build --workspace
./target/debug/claw --help
./target/debug/claw prompt "summarize this repository"
```

### Authentication

```bash
# Option 1: API Key
export OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 and OLLAMA_MODEL=qwen3:4b="sk-ant-..."

# Option 2: OAuth
./target/debug/claw login
```

---

## 2. FRIDAY (Your Main Project)

**Location:** `friday/` directory  
**Language:** TypeScript/Node.js  
**Type:** Fully Responsive Intelligent Digital Assistant System

### What is FRIDAY?

FRIDAY is a comprehensive AI assistant system that provides a natural language interface to Claw Code, adding voice capabilities, memory management, system control, and a web-based dashboard. It acts as a user-friendly layer on top of the powerful Claw engine.

### Architecture Layers

```
┌─────────────────────────────────────────┐
│  Web Dashboard (UI)                     │
│  └─ HTML/CSS/JS Interface               │
└─────────────────────────────────────────┘
               ↓ HTTP/WebSocket
┌─────────────────────────────────────────┐
│  API Layer (Express + WebSocket)        │
│  └─ /friday/run, /friday/voice, etc.    │
└─────────────────────────────────────────┘
               ↓
┌─────────────────────────────────────────┐
│  Intelligence Layer                      │
│  └─ Intent Parser (NLP)                 │
└─────────────────────────────────────────┘
               ↓
┌─────────────────────────────────────────┐
│  Orchestration Layer                     │
│  ├─ Task Router                         │
│  ├─ Safety Gate                         │
│  └─ Claw Bridge ←─────────────────┐    │
└─────────────────────────────────────────┘
               ↓                            │
┌─────────────────────────────────────────┐
│  Execution Layers                        │
│  ├─ Claw Engine (code tasks) ──────────┘
│  ├─ Control Layer (system, apps)       │
│  ├─ Memory Layer (SQLite)              │
│  └─ Voice Layer (STT/TTS)              │
└─────────────────────────────────────────┘
```

### Key Features

1. **Natural Language Interface**
   - Pattern-based intent parsing
   - Confidence scoring
   - Context-aware responses

2. **Voice Capabilities**
   - Browser microphone transcription (Web Speech API; browser support and network behavior vary)
   - Browser speech synthesis (OS/browser voices)
   - Wake word support

3. **Memory System**
   - Persistent SQLite database
   - Conversation history
   - Task logging
   - User preferences
   - Contacts and facts

4. **Safety & Security**
   - Risk classification (low/medium/high)
   - Approval system for high-risk actions
   - Rate limiting (100 req/min)
   - Input validation
   - Command injection protection

5. **System Control**
   - WhatsApp messaging
   - Browser control
   - Application management
   - PC control (optional)
   - Screenshots

6. **Real-Time Communication**
   - WebSocket support
   - Live task progress updates
   - Streaming responses
   - Event broadcasting

### FRIDAY Components

| Module | Purpose |
|--------|---------|
| **src/api/server.ts** | Express + WebSocket server |
| **src/intelligence/intentParser.ts** | NLP intent classification |
| **src/orchestration/taskRouter.ts** | Task routing logic |
| **src/orchestration/clawBridge.ts** | Interface to Claw binary |
| **src/orchestration/safetyGate.ts** | Risk evaluation & approval |
| **src/memory/store.ts** | SQLite persistence |
| **src/voice/stt.ts** | Speech-to-text |
| **src/voice/tts.ts** | Text-to-speech |
| **src/control/controlRouter.ts** | System control operations |
| **ui/** | Web dashboard (HTML/CSS/JS) |

### API Endpoints

- **Task Execution**: `POST /friday/run`, `POST /friday/voice`
- **Approval**: `POST /friday/approve`, `GET /friday/pending`
- **History**: `GET /friday/history`
- **Memory**: `/friday/memory/store`, `/friday/memory/search`, `/friday/memory/retrieve`, `/friday/memory/conversations`, `/friday/memory/stats`
- **Health**: `GET /friday/health`, `GET /friday/status`
- **WebSocket**: `ws://localhost:3141/friday/ws`

### Supported Actions

**Code Operations** (via Claw):
- `code_task`, `file_read`, `file_write`, `file_delete`
- `terminal_command`, `git_operation`, `project_analysis`
- `web_search`, `summarize`, `answer_question`

**System Control**:
- `send_whatsapp`, `open_browser`, `browser_navigate`
- `open_app`, `close_app`, `pc_control`, `take_screenshot`

**Information**:
- `time_date`, `weather`, `system_status`

**Memory**:
- `memory_store`, `memory_recall`, `set_preference`

**Conversational**:
- `greeting`, `farewell`, `clarification`, `unknown`

### Quick Start

```bash
# 1. Install dependencies
cd friday
npm install

# 2. Configure environment
cp .env.example .env
# Set OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 and OLLAMA_MODEL=qwen3:4b

# 3. Build Claw (if not already built)
cd ../rust
cargo build --workspace

# 4. Run FRIDAY
cd ../friday
npm run dev
```

### Access Points

- **Dashboard**: http://127.0.0.1:3141
- **API**: http://127.0.0.1:3141/friday/run
- **WebSocket**: ws://127.0.0.1:3141/friday/ws
- **Health Check**: http://127.0.0.1:3141/friday/health

---

## How They Work Together

### Integration Flow

```
User Input
    ↓
FRIDAY API (receives text/voice)
    ↓
Intent Parser (classifies action)
    ↓
Task Router (routes to executor)
    ↓
┌─────────────────────────────────────┐
│ If code-related task                │
│    ↓                                │
│ Claw Bridge                         │
│    ↓                                │
│ Execute Claw CLI                    │
│ ../rust/target/debug/claw prompt    │
│    ↓                                │
│ Claw processes with the local Ollama model       │
│    ↓                                │
│ Return result to FRIDAY             │
└─────────────────────────────────────┘
    ↓
FRIDAY formats response
    ↓
Return to user (text/voice/WebSocket)
```

### Communication

FRIDAY communicates with Claw through:
1. **Process Execution**: Uses Node.js `execFile()` to invoke the Claw binary
2. **Command Line Arguments**: `claw prompt "<user_request>"`
3. **Environment Variables**: Passes `OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 and OLLAMA_MODEL=qwen3:4b` and configuration
4. **STDOUT/STDERR**: Captures Claw's output and returns to user

### Example Interaction

```javascript
// User asks: "Read the README.md file"

// 1. FRIDAY receives request
POST /friday/run
{ "text": "Read the README.md file" }

// 2. Intent Parser classifies
Action: file_read
Confidence: 0.8
Risk: low

// 3. Task Router → Claw Bridge
ClawBridge.invoke({
  prompt: "Read the file at README.md and show me its contents."
})

// 4. Executes command
execFile('../rust/target/debug/claw', ['prompt', 'Read the file at README.md...'])

// 5. Claw executes with the local Ollama model
// Uses read_file tool, returns content

// 6. FRIDAY returns result
{
  "success": true,
  "output": "# Claw Code\n\nClaw Code is...",
  "executor": "claw",
  "durationMs": 1234
}
```

---

## Configuration

### Claw Code Configuration

Located in multiple places (priority order):
1. `~/.claw.json` (user-level)
2. `~/.config/claw/settings.json`
3. `<repo>/.claw.json` (project-level)
4. `<repo>/.claw/settings.json`
5. `<repo>/.claw/settings.local.json`

**Key settings:**
```json
{
  "model": "qwen3:4b",
  "permissionMode": "danger-full-access",
  "allowedTools": ["*"],
  "mcpServers": {},
  "hooks": []
}
```

### FRIDAY Configuration

Located in `friday/.env`:

```bash
# Required
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=qwen3:4b

# Server
FRIDAY_PORT=3141
FRIDAY_HOST=127.0.0.1

# Claw Integration (auto-detected if not set)
CLAW_BINARY_PATH=/path/to/rust/target/debug/claw

# Voice (optional)
STT_ENGINE=none
TTS_ENGINE=none

# Safety
RATE_LIMIT_PER_MINUTE=30
HIGH_RISK_LIMIT_PER_HOUR=5
REQUIRE_HIGH_RISK_APPROVAL=true

# Control (optional)
ENABLE_BROWSER_CONTROL=false
ENABLE_PC_CONTROL=false
```

---

## Development Workflow

### Working on Claw Code

```bash
cd rust

# Build
cargo build --workspace

# Test
cargo test --workspace

# Run
./target/debug/claw

# Lint
cargo fmt --all --check
cargo clippy --workspace
```

### Working on FRIDAY

```bash
cd friday

# Install
npm install

# Development mode
npm run dev

# Build
npm run build

# Production mode
npm start
```

### Testing the Integration

```bash
# Terminal 1: Start FRIDAY
cd friday
npm run dev

# Terminal 2: Test with curl
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "What time is it?"}'

# Terminal 3: Monitor logs
tail -f friday/data/logs/friday.log
```

---

## Project Philosophy

From `PHILOSOPHY.md`:

> **Claw Code is a demo of autonomous software development.**
>
> Humans provide direction. Claws coordinate, build, test, recover, and push. The repository is the artifact. The philosophy is the system behind it.

### Key Principles

1. **Humans set direction; claws perform labor**
2. **The bottleneck is no longer typing speed** - it's architectural clarity and judgment
3. **Built for autonomous operation** - designed for AI agents first, humans second
4. **Event-first, not log-first** - structured state over scraped logs
5. **Recovery before escalation** - auto-heal known failures

---

## Ecosystem

Part of the **UltraWorkers** toolchain:

- **Claw Code** - CLI agent harness (this repo)
- **FRIDAY** - User-facing AI assistant (this repo)
- [clawhip](https://github.com/Yeachan-Heo/clawhip) - Event and notification router
- [oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) - Multi-agent coordination
- [oh-my-codex (OmX)](https://github.com/Yeachan-Heo/oh-my-codex) - Workflow layer
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
- [UltraWorkers Discord](https://discord.gg/5TUQKqFWd)

---

## Documentation Map

### Root Level
- **README.md** - Repository overview and quick start
- **USAGE.md** - Claw Code usage examples and commands
- **PHILOSOPHY.md** - Project vision and principles
- **ROADMAP.md** - Development roadmap and backlog
- **PARITY.md** - Rust port status tracking
- **PROJECT_OVERVIEW.md** (this file) - Complete project structure

### Claw Code
- **rust/README.md** - Rust implementation details
- **rust/MOCK_PARITY_HARNESS.md** - Testing infrastructure
- **rust/USAGE.md** - Detailed CLI usage
- **docs/container.md** - Docker/Podman workflow

### FRIDAY
- **friday/OPENAPI.md** - Complete API documentation
- **friday/.env.example** - Configuration template
- **friday/ui/index.html** - Web dashboard

---

## Statistics

### Repository Totals
- **~52,000+ lines** of code (Rust + TypeScript)
- **292 commits** on main
- **3 authors**
- **Development period**: 2026-03-31 → 2026-04-03

### Claw Code (Rust)
- **48,599 lines** of Rust code
- **2,568 lines** of test code
- **9 crates**
- **40+ tools**

### FRIDAY (TypeScript)
- **~3,500 lines** of TypeScript
- **12 API endpoints**
- **10 WebSocket message types**
- **6 architectural layers**

---

## Getting Started

### For Users (FRIDAY)

1. **Build Claw Code:**
   ```bash
   cd rust
   cargo build --workspace
   ```

2. **Configure FRIDAY:**
   ```bash
   cd ../friday
   cp .env.example .env
   # Edit .env and add OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 and OLLAMA_MODEL=qwen3:4b
   ```

3. **Install and Run:**
   ```bash
   npm install
   npm run dev
   ```

4. **Open Dashboard:**
   Visit http://127.0.0.1:3141

### For Developers (Claw Code)

1. **Clone and Build:**
   ```bash
   cd rust
   cargo build --workspace
   ```

2. **Set API Key:**
   ```bash
   export OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 and OLLAMA_MODEL=qwen3:4b="sk-ant-..."
   ```

3. **Run:**
   ```bash
   ./target/debug/claw
   ```

4. **First Command:**
   ```bash
   /doctor
   ```

---

## Support & Community

- **GitHub**: [ultraworkers/claw-code](https://github.com/ultraworkers/claw-code)
- **Discord**: [UltraWorkers Discord](https://discord.gg/5TUQKqFWd)
- **Issues**: Use GitHub Issues for bugs and feature requests

---

## License

See the repository root for license information.

---

## Disclaimer

This repository:
- Does **not** claim ownership of the original Ollama Code source material
- Is **not affiliated with, endorsed by, or maintained by Anthropic**
- Is part of the open-source **UltraWorkers** ecosystem

---

**Last Updated**: July 15, 2026  
**Claw Code Version**: Rust port (post 9-lane checkpoint)  
**FRIDAY Version**: 1.0.0
