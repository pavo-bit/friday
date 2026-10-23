// ============================================================
// FRIDAY — Dashboard Application
// Real-time UI powered by WebSocket + REST API
// ============================================================

(function () {
  'use strict';

  // ---- Configuration ----
  const API_BASE = window.location.origin;
  const WS_URL = `ws://${window.location.host}/friday/ws`;

  // ---- DOM Elements ----
  const messageList = document.getElementById('messageList');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const voiceBtn = document.getElementById('voiceBtn');
  const clearChatBtn = document.getElementById('clearChatBtn');
  const taskLog = document.getElementById('taskLog');
  const taskCount = document.getElementById('taskCount');
  const approvalsList = document.getElementById('approvalsList');
  const approvalsCard = document.getElementById('approvalsCard');
  const approvalCount = document.getElementById('approvalCount');
  const uptimeDisplay = document.getElementById('uptimeDisplay');

  // Status indicators
  const clawStatus = document.getElementById('clawStatus');
  const voiceStatus = document.getElementById('voiceStatus');
  const memoryStatus = document.getElementById('memoryStatus');

  // Stats
  const statInvocations = document.getElementById('statInvocations');
  const statTasks = document.getElementById('statTasks');
  const statMemories = document.getElementById('statMemories');
  const statEvents = document.getElementById('statEvents');

  // ---- State ----
  let ws = null;
  let isProcessing = false;
  let isRecording = false;
  let mediaRecorder = null;
  let audioChunks = [];
  let taskCountValue = 0;

  // ---- WebSocket Connection ----
  function connectWebSocket() {
    try {
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        console.log('[FRIDAY] WebSocket connected');
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleWsMessage(message);
        } catch (e) {
          console.warn('[FRIDAY] Invalid WS message:', e);
        }
      };

      ws.onclose = () => {
        console.log('[FRIDAY] WebSocket disconnected, reconnecting in 3s...');
        setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = (error) => {
        console.error('[FRIDAY] WebSocket error:', error);
      };
    } catch (e) {
      console.warn('[FRIDAY] WebSocket connection failed, retrying...');
      setTimeout(connectWebSocket, 5000);
    }
  }

  function handleWsMessage(message) {
    switch (message.type) {
      case 'task_started':
        showTypingIndicator();
        break;
      case 'task_completed':
        hideTypingIndicator();
        if (message.payload) {
          addTaskToLog(message.payload);
        }
        break;
      case 'task_failed':
        hideTypingIndicator();
        if (message.payload) {
          addTaskToLog(message.payload);
        }
        break;
      case 'approval_needed':
        if (message.payload) {
          showApprovalRequest(message.payload);
        }
        break;
      case 'system_status':
        console.log('[FRIDAY] System status:', message.payload);
        break;
    }
  }

  // ---- API Calls ----
  async function sendMessage(text) {
    if (!text.trim() || isProcessing) return;

    isProcessing = true;
    sendBtn.disabled = true;

    // Add user message
    addMessage('user', text);
    userInput.value = '';
    autoResize();

    // Show typing indicator
    showTypingIndicator();

    try {
      const response = await fetch(`${API_BASE}/friday/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      const data = await response.json();

      hideTypingIndicator();

      if (data.error) {
        addMessage('assistant', `❌ Error: ${data.error}`);
      } else {
        const output = data.output || data.error || 'Task completed with no output.';
        addMessage('assistant', output, data);
        addTaskToLog(data);
      }
    } catch (error) {
      hideTypingIndicator();
      addMessage('assistant', `❌ Connection error: ${error.message}. Is FRIDAY running?`);
    } finally {
      isProcessing = false;
      sendBtn.disabled = false;
      userInput.focus();
    }
  }

  async function fetchHealth() {
    try {
      const response = await fetch(`${API_BASE}/friday/health`);
      const data = await response.json();
      updateStatus(data);
    } catch {
      clawStatus.className = 'status-chip offline';
      voiceStatus.className = 'status-chip offline';
      memoryStatus.className = 'status-chip offline';
    }
  }

  function updateStatus(health) {
    // Claw status
    if (health.subsystems?.claw?.status === 'online') {
      clawStatus.className = 'status-chip online';
    } else {
      clawStatus.className = 'status-chip offline';
    }

    // Voice status
    const sttAvailable = health.subsystems?.voice?.stt?.available;
    const ttsAvailable = health.subsystems?.voice?.tts?.available;
    if (sttAvailable && ttsAvailable) {
      voiceStatus.className = 'status-chip online';
    } else if (sttAvailable || ttsAvailable) {
      voiceStatus.className = 'status-chip partial';
    } else {
      voiceStatus.className = 'status-chip offline';
    }

    // Memory status
    if (health.subsystems?.memory?.dbExists) {
      memoryStatus.className = 'status-chip online';
    } else {
      memoryStatus.className = 'status-chip partial';
    }

    // Stats
    statInvocations.textContent = health.subsystems?.claw?.totalInvocations || 0;
    statTasks.textContent = taskCountValue;

    // Uptime
    const uptime = health.uptime_seconds || 0;
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const secs = uptime % 60;
    uptimeDisplay.textContent = `Uptime: ${hours}h ${mins}m ${secs}s`;

    // Event bus stats
    const events = health.events || {};
    const totalEvents = Object.values(events).reduce((a, b) => a + b, 0);
    statEvents.textContent = totalEvents;
  }

  // ---- UI Helpers ----
  function addMessage(role, text, data) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';

    const content = document.createElement('div');
    content.className = 'message-content';

    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    textDiv.innerHTML = formatMessage(text);

    content.appendChild(textDiv);

    // Add metadata for assistant messages
    if (role === 'assistant' && data) {
      const meta = document.createElement('div');
      meta.className = 'message-meta';

      if (data.executor) {
        meta.innerHTML += `<span>via ${data.executor}</span>`;
      }
      if (data.durationMs) {
        meta.innerHTML += `<span>${data.durationMs}ms</span>`;
      }
      if (data.risk) {
        const riskColors = { low: '#22c55e', medium: '#f59e0b', high: '#ef4444' };
        meta.innerHTML += `<span style="color:${riskColors[data.risk] || '#94a3b8'}">${data.risk} risk</span>`;
      }

      content.appendChild(meta);
    }

    msgDiv.appendChild(avatar);
    msgDiv.appendChild(content);
    messageList.appendChild(msgDiv);

    // Scroll to bottom
    messageList.scrollTop = messageList.scrollHeight;
  }

  function formatMessage(text) {
    if (!text) return '<em>No output</em>';

    // Basic markdown-like formatting
    return text
      // Code blocks
      .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--accent-cyan)">$1</a>')
      // Bullet lists
      .replace(/^[-•]\s+(.+)/gm, '<li>$1</li>')
      // Line breaks
      .replace(/\n/g, '<br>');
  }

  function showTypingIndicator() {
    if (document.getElementById('typingIndicator')) return;

    const indicator = document.createElement('div');
    indicator.id = 'typingIndicator';
    indicator.className = 'message assistant';
    indicator.innerHTML = `
      <div class="message-avatar">🤖</div>
      <div class="message-content">
        <div class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
    messageList.appendChild(indicator);
    messageList.scrollTop = messageList.scrollHeight;
  }

  function hideTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) indicator.remove();
  }

  function addTaskToLog(data) {
    taskCountValue++;
    taskCount.textContent = taskCountValue;
    statTasks.textContent = taskCountValue;

    // Remove empty state
    const emptyState = taskLog.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const item = document.createElement('div');
    item.className = 'task-item';

    const icon = data.success ? '✅' : '❌';
    const action = data.intent?.action || data.executor || 'unknown';
    const detail = (data.output || data.error || '').substring(0, 60);
    const time = data.durationMs ? `${data.durationMs}ms` : '';

    item.innerHTML = `
      <span class="task-icon">${icon}</span>
      <div class="task-info">
        <div class="task-action">${escapeHtml(action)}</div>
        <div class="task-detail">${escapeHtml(detail)}</div>
      </div>
      <span class="task-time">${time}</span>
    `;

    // Prepend (newest first)
    taskLog.insertBefore(item, taskLog.firstChild);

    // Limit to 50 items
    while (taskLog.children.length > 50) {
      taskLog.removeChild(taskLog.lastChild);
    }
  }

  function showApprovalRequest(request) {
    approvalsCard.style.display = 'block';
    const count = parseInt(approvalCount.textContent || '0') + 1;
    approvalCount.textContent = count;

    const item = document.createElement('div');
    item.className = 'approval-item';
    item.id = `approval-${request.id}`;
    item.innerHTML = `
      <div class="approval-desc">${escapeHtml(request.description)}</div>
      <div class="approval-impact">${escapeHtml(request.impact)}</div>
      <div class="approval-actions">
        <button class="btn-approve" onclick="handleApproval('${request.id}', true)">✓ Approve</button>
        <button class="btn-deny" onclick="handleApproval('${request.id}', false)">✕ Deny</button>
      </div>
    `;
    approvalsList.appendChild(item);
  }

  window.handleApproval = async function (requestId, approved) {
    try {
      await fetch(`${API_BASE}/friday/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, approved }),
      });

      const item = document.getElementById(`approval-${requestId}`);
      if (item) {
        item.style.opacity = '0.5';
        item.innerHTML = `<div class="approval-desc">${approved ? '✅ Approved' : '❌ Denied'}</div>`;
        setTimeout(() => item.remove(), 2000);
      }

      const count = Math.max(0, parseInt(approvalCount.textContent || '1') - 1);
      approvalCount.textContent = count;
      if (count === 0) approvalsCard.style.display = 'none';
    } catch (error) {
      console.error('Approval error:', error);
    }
  };

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // ---- Voice Recording ----
  async function toggleRecording() {
    if (isRecording) {
      stopRecording();
    } else {
      await startRecording();
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = reader.result.split(',')[1];
          await sendVoice(base64);
        };
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      isRecording = true;
      voiceBtn.classList.add('recording');
    } catch (error) {
      console.error('Microphone access denied:', error);
      addMessage('assistant', '🎙️ Microphone access denied. Please allow microphone access to use voice input.');
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
    isRecording = false;
    voiceBtn.classList.remove('recording');
  }

  async function sendVoice(audioBase64) {
    isProcessing = true;
    sendBtn.disabled = true;
    showTypingIndicator();

    try {
      const response = await fetch(`${API_BASE}/friday/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: audioBase64, format: 'webm' }),
      });

      const data = await response.json();
      hideTypingIndicator();

      if (data.transcript) {
        addMessage('user', `🎙️ ${data.transcript}`);
      }

      if (data.response) {
        addMessage('assistant', data.response.text, data.response.result);

        // Play audio response if available
        if (data.response.audio) {
          playAudio(data.response.audio);
        }
      } else if (data.error) {
        addMessage('assistant', `❌ ${data.error}`);
      }
    } catch (error) {
      hideTypingIndicator();
      addMessage('assistant', `❌ Voice processing error: ${error.message}`);
    } finally {
      isProcessing = false;
      sendBtn.disabled = false;
    }
  }

  function playAudio(base64Audio) {
    try {
      const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`);
      audio.play().catch((e) => console.warn('Audio playback failed:', e));
    } catch (e) {
      console.warn('Audio playback error:', e);
    }
  }

  // ---- Textarea Auto-resize ----
  function autoResize() {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
  }

  // ---- Event Listeners ----
  sendBtn.addEventListener('click', () => sendMessage(userInput.value));

  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(userInput.value);
    }
  });

  userInput.addEventListener('input', autoResize);

  voiceBtn.addEventListener('click', toggleRecording);

  clearChatBtn.addEventListener('click', () => {
    // Keep the welcome message (first child)
    while (messageList.children.length > 1) {
      messageList.removeChild(messageList.lastChild);
    }
  });

  // ---- Boot ----
  connectWebSocket();
  fetchHealth();
  setInterval(fetchHealth, 10000); // Poll health every 10s

  console.log('[FRIDAY] Dashboard initialized');
})();
