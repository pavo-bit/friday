# FRIDAY API Documentation

## Overview

**FRIDAY** (Fully Responsive Intelligent Digital Assistant System) is an AI-powered assistant that bridges voice/text input with the Claw Code engine to perform various tasks including code operations, system control, memory management, and more.

- **Version**: 1.0.0
- **Base URL**: `http://127.0.0.1:3141`
- **API Prefix**: `/friday`
- **WebSocket**: `ws://127.0.0.1:3141/friday/ws`

## Architecture

FRIDAY is built with a layered architecture:

1. **API Layer** - Express + WebSocket gateway for HTTP and real-time communication
2. **Intelligence Layer** - Intent parsing and natural language understanding
3. **Orchestration Layer** - Task routing, safety evaluation, and Claw bridge
4. **Control Layer** - System-level operations (browser, apps, PC automation)
5. **Communication Layer** - Email (SMTP/IMAP), WhatsApp, translation, and thread summarization
6. **Memory Layer** - Persistent SQLite storage for conversations, tasks, and preferences
7. **Voice Layer** - Browser microphone transcription and browser speech synthesis

## Authentication

Currently, FRIDAY operates on localhost and does not require authentication. Access control is managed through:
- IP-based rate limiting (100 requests per minute)
- High-risk action approval system
- Configurable allowed directories for file operations

## Rate Limiting

- **General requests**: 100 per minute per IP
- **High-risk actions**: 5 per hour (configurable)
- Rate limit exceeded returns: `429 Too Many Requests`

---

## API Endpoints

### Task Execution

#### POST `/friday/run`

Execute a text-based task. This is the main endpoint for interacting with FRIDAY.

**Request Body:**
```json
{
  "text": "string (required, max 32,000 chars)",
  "sessionId": "string (optional)"
}
```

**Response:** `200 OK`
```json
{
  "id": "uuid",
  "intentId": "uuid",
  "success": true,
  "output": "Task completed successfully...",
  "error": "string (if failed)",
  "executor": "claw | control | memory | internal | communication",
  "durationMs": 1234,
  "risk": "low | medium | high",
  "approved": true,
  "timestamp": "2026-07-15T10:30:00.000Z",
  "intent": {
    "action": "code_task",
    "target": "file.ts",
    "operation": "read",
    "data": "...",
    "risk": "low"
  }
}
```

**Supported Actions:**
- **Code Operations**: `code_task`, `file_read`, `file_write`, `file_delete`, `terminal_command`, `git_operation`, `project_analysis`
- **Communication**: `draft_email`, `send_email`, `read_email`, `summarize_thread`, `translate_message`, `send_whatsapp`
- **System Control**: `open_browser`, `browser_navigate`, `open_app`, `close_app`, `pc_control`, `take_screenshot`
- **Information**: `web_search`, `summarize`, `answer_question`, `time_date`, `weather`
- **Memory**: `memory_store`, `memory_recall`, `set_preference`, `system_status`
- **Conversational**: `greeting`, `farewell`, `clarification`, `unknown`

**Error Responses:**
- `400 Bad Request` - Missing or invalid text field
- `413 Payload Too Large` - Input exceeds 32,000 characters
- `500 Internal Server Error` - Processing error

**Example Requests:**

```bash
# Simple greeting
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello FRIDAY"}'

# Code task
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Read the file src/index.ts and explain what it does"}'

# System control
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Open Chrome and go to github.com"}'

# Draft an email
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Draft an email to john@example.com about the project deadline"}'

# Send an email (requires approval)
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Send email to alice@company.com subject Meeting Tomorrow saying Let us meet at 3 PM"}'

# Read recent emails
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Check my unread emails"}'

# Summarize a thread
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Summarize the email thread about project launch"}'

# Translate a message
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Translate this message to Spanish: The meeting is at 3 PM tomorrow"}'
```

---

#### POST `/friday/voice`

Process voice input, transcribe it, execute the task, and return both text and audio response.

**Request Body:**
```json
{
  "audio": "string (required, base64 encoded audio data)",
  "format": "string (optional, default: 'webm')"
}
```

**Response:** `200 OK`
```json
{
  "transcript": "the transcribed text from audio",
  "response": {
    "text": "FRIDAY's response text",
    "audio": "base64 encoded audio response (if TTS available)",
    "result": {
      "id": "uuid",
      "success": true,
      "output": "...",
      "executor": "claw",
      "durationMs": 2345,
      "risk": "low",
      "approved": true,
      "timestamp": "2026-07-15T10:30:00.000Z"
    }
  }
}
```

**Error Responses:**
- `400 Bad Request` - Missing audio field
- `503 Service Unavailable` - STT engine not configured
- `500 Internal Server Error` - Voice processing failed

**Requirements:**
- Dashboard voice input uses the browser Web Speech API (Chrome/Edge support varies and recognition may use an online browser service).
- Spoken replies use the browser SpeechSynthesis API and installed system voices.
- Neither dashboard voice feature requires a paid API key. The server-side `/friday/voice` audio-upload route remains disabled unless a local STT engine is implemented.

---

### Approval System

High-risk actions require user approval before execution.

#### POST `/friday/approve`

Approve or deny a pending high-risk action.

**Request Body:**
```json
{
  "requestId": "string (required)",
  "approved": true
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "approved": true
}
```

**Error Responses:**
- `400 Bad Request` - Missing requestId or approved field
- `404 Not Found` - Approval request not found or already processed

---

#### GET `/friday/pending`

Get all pending approval requests.

**Response:** `200 OK`
```json
{
  "pending": [
    {
      "id": "uuid",
      "intent": {
        "id": "uuid",
        "rawInput": "delete all log files",
        "action": "file_delete",
        "params": {},
        "confidence": 0.85,
        "risk": "high",
        "timestamp": "2026-07-15T10:30:00.000Z"
      },
      "description": "File deletion",
      "risk": "high",
      "impact": "This will permanently delete files",
      "pending": true,
      "createdAt": "2026-07-15T10:30:00.000Z"
    }
  ]
}
```

---

#### GET `/friday/history`

Get recent task execution history.

**Query Parameters:**
- `limit` - Number of tasks to return (default: 20)

**Response:** `200 OK`
```json
{
  "tasks": [
    {
      "id": "uuid",
      "intentId": "uuid",
      "success": true,
      "output": "Task output...",
      "executor": "claw",
      "durationMs": 1234,
      "risk": "low",
      "approved": true,
      "timestamp": "2026-07-15T10:30:00.000Z"
    }
  ]
}
```

---

### Memory Management

FRIDAY maintains a persistent memory store for conversations, tasks, preferences, contacts, and facts.

#### POST `/friday/memory/store`

Store a new memory entry.

**Request Body:**
```json
{
  "type": "conversation | task | preference | contact | fact",
  "key": "string (required)",
  "value": "string (required)",
  "metadata": {
    "category": "optional metadata",
    "tags": "comma,separated,tags"
  }
}
```

**Response:** `200 OK`
```json
{
  "id": "uuid",
  "stored": true
}
```

**Error Responses:**
- `400 Bad Request` - Missing required fields or invalid type

---

#### GET `/friday/memory/search`

Search memories using keyword matching.

**Query Parameters:**
- `q` - Search query (required)
- `limit` - Number of results (default: 10)

**Response:** `200 OK`
```json
{
  "results": [
    {
      "id": "uuid",
      "type": "conversation",
      "key": "user_message",
      "value": "Hello FRIDAY",
      "metadata": {},
      "createdAt": "2026-07-15T10:30:00.000Z",
      "lastAccessedAt": "2026-07-15T10:30:00.000Z",
      "accessCount": 1
    }
  ],
  "count": 1
}
```

**Error Responses:**
- `400 Bad Request` - Missing query parameter

---

#### GET `/friday/memory/retrieve`

Retrieve memories by type and/or key pattern.

**Query Parameters:**
- `type` - Memory type filter (optional)
- `key` - Key pattern filter (optional)
- `limit` - Number of results (default: 20)

**Response:** `200 OK`
```json
{
  "results": [
    {
      "id": "uuid",
      "type": "preference",
      "key": "theme",
      "value": "dark",
      "metadata": {},
      "createdAt": "2026-07-15T10:30:00.000Z",
      "lastAccessedAt": "2026-07-15T10:30:00.000Z",
      "accessCount": 5
    }
  ],
  "count": 1
}
```

---

#### GET `/friday/memory/conversations`

Get recent conversation history.

**Query Parameters:**
- `limit` - Number of conversations (default: 50)
- `session` - Session ID filter (optional)

**Response:** `200 OK`
```json
{
  "conversations": [
    {
      "id": "uuid",
      "role": "user | assistant",
      "content": "conversation text",
      "action": "greeting",
      "sessionId": "uuid",
      "timestamp": "2026-07-15T10:30:00.000Z"
    }
  ],
  "count": 50
}
```

---

#### GET `/friday/memory/stats`

Get memory store statistics.

**Response:** `200 OK`
```json
{
  "totalMemories": 1234,
  "totalTasks": 567,
  "totalConversations": 890,
  "byType": {
    "conversation": 890,
    "task": 567,
    "preference": 45,
    "contact": 12,
    "fact": 89
  },
  "dbSizeMB": 2.5,
  "oldestEntry": "2026-01-01T00:00:00.000Z",
  "newestEntry": "2026-07-15T10:30:00.000Z"
}
```

---

### Health & Status

#### GET `/friday/health`

Comprehensive system health check with detailed subsystem status.

**Response:** `200 OK`
```json
{
  "status": "ok | degraded",
  "version": "1.0.0",
  "timestamp": "2026-07-15T10:30:00.000Z",
  "uptime_seconds": 3600,
  "subsystems": {
    "claw": {
      "status": "online | offline",
      "binary": "/path/to/claw",
      "exists": true,
      "activeProcesses": 2,
      "totalInvocations": 123
    },
    "voice": {
      "stt": {
        "engine": "whisper_api | whisper_local | none",
        "available": true
      },
      "tts": {
        "engine": "openai | edge | none",
        "available": true
      }
    },
    "safety": {
      "requireApproval": true,
      "rateLimitPerMinute": 30,
      "highRiskLimitPerHour": 5,
      "pendingApprovals": 0
    },
    "memory": {
      "dbPath": "/path/to/friday.db",
      "dbExists": true
    },
    "control": {
      "browserEnabled": false,
      "pcEnabled": false
    },
    "communication": {
      "emailConfigured": true,
      "smtpHost": "smtp.gmail.com",
      "imapHost": "imap.gmail.com",
      "fromAddress": "you@example.com"
    }
  },
  "events": {
    "totalEvents": 456,
    "listeners": {
      "system:ready": 1,
      "task:started": 2,
      "task:completed": 2
    }
  }
}
```

---

#### GET `/friday/status`

Lightweight status check for monitoring.

**Response:** `200 OK`
```json
{
  "ok": true,
  "claw": true,
  "uptime": 3600
}
```

---

## WebSocket API

Real-time bidirectional communication for live updates and streaming.

**Endpoint:** `ws://127.0.0.1:3141/friday/ws`

### Message Format

All WebSocket messages follow this envelope structure:

```json
{
  "type": "message_type",
  "payload": {},
  "timestamp": "2026-07-15T10:30:00.000Z"
}
```

### Client → Server Messages

#### `VOICE_DATA`
Send audio data for voice processing.
```json
{
  "type": "voice_data",
  "payload": {
    "audio": "base64 encoded audio",
    "format": "webm"
  }
}
```

#### `TEXT_INPUT`
Send text input for processing.
```json
{
  "type": "text_input",
  "payload": {
    "text": "user command or question"
  }
}
```

#### `APPROVAL_RESPONSE`
Respond to an approval request.
```json
{
  "type": "approval_response",
  "payload": {
    "requestId": "uuid",
    "approved": true
  }
}
```

#### `CANCEL_TASK`
Cancel a running task.
```json
{
  "type": "cancel_task",
  "payload": {
    "taskId": "uuid"
  }
}
```

### Server → Client Messages

#### `SYSTEM_STATUS`
System connection status (sent on connect).
```json
{
  "type": "system_status",
  "payload": {
    "connected": true,
    "timestamp": "2026-07-15T10:30:00.000Z"
  }
}
```

#### `TRANSCRIPT`
Voice transcription result.
```json
{
  "type": "transcript",
  "payload": {
    "text": "transcribed audio"
  }
}
```

#### `INTENT_PARSED`
Intent classification result.
```json
{
  "type": "intent_parsed",
  "payload": {
    "intentId": "uuid",
    "action": "code_task",
    "confidence": 0.85,
    "risk": "low"
  }
}
```

#### `TASK_STARTED`
Task execution started.
```json
{
  "type": "task_started",
  "payload": {
    "intentId": "uuid",
    "action": "file_read"
  }
}
```

#### `TASK_PROGRESS`
Task execution progress update.
```json
{
  "type": "task_progress",
  "payload": {
    "intentId": "uuid",
    "progress": 0.5,
    "message": "Reading file..."
  }
}
```

#### `TASK_COMPLETED`
Task execution completed successfully.
```json
{
  "type": "task_completed",
  "payload": {
    "id": "uuid",
    "success": true,
    "output": "Task result...",
    "durationMs": 1234
  }
}
```

#### `TASK_FAILED`
Task execution failed.
```json
{
  "type": "task_failed",
  "payload": {
    "id": "uuid",
    "success": false,
    "error": "Error message",
    "durationMs": 567
  }
}
```

#### `APPROVAL_NEEDED`
High-risk action requires approval.
```json
{
  "type": "approval_needed",
  "payload": {
    "requestId": "uuid",
    "description": "File deletion",
    "risk": "high",
    "impact": "This will permanently delete files"
  }
}
```

#### `TTS_AUDIO`
Text-to-speech audio response.
```json
{
  "type": "tts_audio",
  "payload": {
    "audio": "base64 encoded audio",
    "format": "mp3"
  }
}
```

#### `ERROR`
Error occurred during processing.
```json
{
  "type": "error",
  "payload": {
    "message": "Error description",
    "code": "ERROR_CODE"
  }
}
```

---

## Data Models

### Intent

Structured representation of user input after parsing.

```typescript
{
  id: string;              // Unique identifier
  rawInput: string;        // Original user text
  action: ActionType;      // Classified action type
  params: object;          // Extracted parameters
  confidence: number;      // 0-1 confidence score
  risk: RiskLevel;         // low | medium | high
  timestamp: string;       // ISO timestamp
  context?: {              // Optional context
    relatedMemories: MemoryEntry[];
    preferences: object;
    systemState: object;
  }
}
```

### TaskResult

Result of task execution.

```typescript
{
  id: string;              // Unique result ID
  intentId: string;        // Related intent ID
  success: boolean;        // Execution success
  output: string;          // Result output
  error?: string;          // Error message if failed
  executor: string;        // claw | control | memory | internal | communication
  durationMs: number;      // Execution time
  risk: RiskLevel;         // Risk level
  approved: boolean;       // Approval status
  timestamp: string;       // ISO timestamp
}
```

### MemoryEntry

Persistent memory record.

```typescript
{
  id: string;              // Unique ID
  type: string;            // conversation | task | preference | contact | fact
  key: string;             // Memory key
  value: string;           // Memory value
  metadata: object;        // Additional metadata
  createdAt: string;       // ISO timestamp
  lastAccessedAt: string;  // ISO timestamp
  accessCount: number;     // Access count
}
```

### Risk Levels

- **LOW**: Read-only, informational operations (auto-execute)
  - Includes: `draft_email`, `read_email`, `summarize_thread`, `translate_message`
- **MEDIUM**: Write operations, app control (execute + audit)
- **HIGH**: Destructive operations, external communications (require approval)
  - Includes: `send_email`, `send_whatsapp`, `file_delete`, `terminal_command`

---

## Configuration

FRIDAY is configured via environment variables in `friday/.env`:

### Required
```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 # Local Ollama endpoint
```

### Server
```bash
FRIDAY_PORT=3141                     # API server port (default: 3141)
FRIDAY_HOST=127.0.0.1               # API server host (default: 127.0.0.1)
```

### Claw Integration
```bash
CLAW_BINARY_PATH=/path/to/claw      # Auto-detected if not set
```

### Voice
```bash
STT_ENGINE=whisper_api              # whisper_api | whisper_local | none
TTS_ENGINE=openai                   # openai | edge | none
STT_ENGINE=none                    # Dashboard uses browser microphone input
TTS_ENGINE=none                    # Dashboard uses browser speech synthesis
WAKE_WORD=friday                    # Voice activation word
```

### Safety
```bash
RATE_LIMIT_PER_MINUTE=30            # Request rate limit
HIGH_RISK_LIMIT_PER_HOUR=5          # High-risk action limit
REQUIRE_HIGH_RISK_APPROVAL=true     # Require approval for high-risk
```

### Memory
```bash
FRIDAY_DB_PATH=./data/friday.db     # SQLite database path
```

### Control
```bash
ALLOWED_DIRECTORIES=.               # Comma-separated allowed paths
ENABLE_BROWSER_CONTROL=false        # Enable browser control
ENABLE_PC_CONTROL=false             # Enable PC control
```

### Communication (Email)
```bash
SMTP_HOST=smtp.gmail.com            # SMTP server host
SMTP_PORT=587                       # SMTP server port (587 for TLS, 465 for SSL)
IMAP_HOST=imap.gmail.com            # IMAP server host
IMAP_PORT=993                       # IMAP server port (993 for SSL)
EMAIL_USER=you@example.com          # Email account username
EMAIL_PASS=app_specific_password    # Email account password / app password
EMAIL_FROM=you@example.com          # Sender address for outgoing email
```

> **Note (Gmail)**: Use an [App Password](https://support.google.com/accounts/answer/185833) — not your account password. Enable 2-Step Verification first, then generate an app-specific password under Security → App Passwords.

---

## Error Handling

### Standard Error Response

```json
{
  "error": "Error message description"
}
```

### HTTP Status Codes

- `200 OK` - Success
- `400 Bad Request` - Invalid request parameters
- `404 Not Found` - Resource not found
- `413 Payload Too Large` - Request body too large
- `429 Too Many Requests` - Rate limit exceeded
- `500 Internal Server Error` - Server processing error
- `503 Service Unavailable` - Required service not configured

---

## Getting Started

### 1. Installation

```bash
cd friday
npm install
```

### 2. Build Claw

```bash
cd ../rust
cargo build --workspace
```

### 3. Configure

Create `friday/.env`:
```bash
cp friday/.env.example friday/.env
# Set OLLAMA_BASE_URL and OLLAMA_MODEL; no API key is needed
```

### 4. Run

```bash
cd friday
npm run dev
```

### 5. Access

- **Dashboard**: http://127.0.0.1:3141
- **API**: http://127.0.0.1:3141/friday/run
- **WebSocket**: ws://127.0.0.1:3141/friday/ws
- **Health**: http://127.0.0.1:3141/friday/health

---

## Examples

### Example 1: Simple Question

```bash
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "What time is it?"}'
```

Response:
```json
{
  "success": true,
  "output": "The current time is 10:30 AM on Wednesday, July 15, 2026.",
  "executor": "internal",
  "durationMs": 5
}
```

### Example 2: File Operation

```bash
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Read the README.md file"}'
```

Response:
```json
{
  "success": true,
  "output": "# FRIDAY\n\nFully Responsive Intelligent Digital Assistant System...",
  "executor": "claw",
  "durationMs": 1234
}
```

### Example 3: Memory Storage

```bash
curl -X POST http://127.0.0.1:3141/friday/memory/store \
  -H "Content-Type: application/json" \
  -d '{
    "type": "preference",
    "key": "favorite_editor",
    "value": "VSCode"
  }'
```

### Example 4: WebSocket Connection

```javascript
const ws = new WebSocket('ws://127.0.0.1:3141/friday/ws');

ws.onopen = () => {
  console.log('Connected to FRIDAY');
  
  // Send a command
  ws.send(JSON.stringify({
    type: 'text_input',
    payload: { text: 'Hello FRIDAY' },
    timestamp: new Date().toISOString()
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received:', message.type, message.payload);
};
```

### Example 5: Draft an Email

```bash
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Draft an email to sarah@company.com about rescheduling our 1:1"}'
```

Response:
```json
{
  "success": true,
  "output": "📧 **Draft Email**\n\nSubject: Rescheduling Our 1:1\n\nHi Sarah,\n\nI hope this message finds you well. I wanted to reach out regarding our upcoming 1:1 meeting. Would it be possible to reschedule?\n\nPlease let me know what times work best for you.\n\nBest regards",
  "executor": "communication",
  "durationMs": 2100,
  "risk": "low"
}
```

### Example 6: Send an Email (with Approval)

```bash
# Step 1: Request send
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Send email to bob@company.com subject Quarterly Report saying Please find the Q3 report attached."}'
```

Response (pending approval):
```json
{
  "success": false,
  "output": "⏸️ Email send requires approval: High-risk action requires user approval",
  "executor": "communication",
  "risk": "high",
  "approved": false
}
```

```bash
# Step 2: Approve via /friday/approve
curl -X POST http://127.0.0.1:3141/friday/approve \
  -H "Content-Type: application/json" \
  -d '{"requestId": "<request-id-from-pending>", "approved": true}'
```

### Example 7: Read Emails

```bash
curl -X POST http://127.0.0.1:3141/friday/run \
  -H "Content-Type: application/json" \
  -d '{"text": "Show my unread emails"}'
```

Response:
```json
{
  "success": true,
  "output": "📬 **3 email(s) found:**\n\n**1.** From: Alice <alice@company.com>\n   Subject: Project Update\n   Date: 2026-07-25T14:00:00.000Z\n\n**2.** From: Bob <bob@company.com>\n   Subject: Meeting Notes\n   Date: 2026-07-25T13:30:00.000Z\n\n**3.** From: HR <hr@company.com>\n   Subject: Policy Update\n   Date: 2026-07-25T10:00:00.000Z",
  "executor": "communication",
  "durationMs": 890,
  "risk": "low"
}
```

---

## Security Considerations

1. **Local-only by default**: FRIDAY binds to 127.0.0.1 and should not be exposed publicly
2. **Rate limiting**: Prevents abuse with per-IP request limits
3. **Approval system**: High-risk operations require explicit user approval
4. **Input validation**: All inputs sanitized and validated
5. **Command injection protection**: Uses execFile() for Claw invocation, not shell interpolation
6. **Allowed directories**: File operations restricted to configured paths
7. **Local model privacy**: FRIDAY sends prompts to the configured local Ollama server; no paid model API key is required.

---

## Integration with Claw Code

FRIDAY acts as a natural language interface to the Claw Code engine. When you send a request to FRIDAY:

1. **Intent Parsing**: User text is classified into action types
2. **Safety Evaluation**: Risk level assessed and approval obtained if needed
3. **Task Routing**: Request routed to appropriate executor:
   - **Claw**: Code operations, file I/O, terminal commands, git operations
   - **Communication**: Email (draft/send/read), thread summarization, translation, WhatsApp
   - **Control**: System-level operations (apps, browser, PC automation)
   - **Internal**: Simple operations handled by FRIDAY directly
4. **Memory Logging**: All interactions stored for context and history
5. **Response**: Result returned as text, with optional voice synthesis

---

## Support

For issues, questions, or contributions:

- **GitHub**: [ultraworkers/claw-code](https://github.com/ultraworkers/claw-code)
- **Discord**: [UltraWorkers Discord](https://discord.gg/5TUQKqFWd)
- **Documentation**: See `friday/README.md` and `USAGE.md`

---

## License

See the main repository for license information.

---

**Last Updated**: July 25, 2026  
**API Version**: 1.1.0  
**FRIDAY Version**: 1.1.0
