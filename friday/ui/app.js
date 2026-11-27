// ============================================================
// FRIDAY — Command Center Dashboard Client
// Connected to real backend APIs & WebSocket stream
// ============================================================

(function () {
  const api = async (url, opts = {}) => {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  // Tabs
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // Clock
  function updateClock() {
    document.getElementById('clockDisplay').textContent = new Date().toLocaleString();
  }
  updateClock();
  setInterval(updateClock, 1000);

  // Voice Output (SpeechSynthesis)
  const voiceSelect = document.getElementById('voiceSelect');
  const rateInput = document.getElementById('voiceRate');
  const pitchInput = document.getElementById('voicePitch');
  let voices = [];

  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    voices = window.speechSynthesis.getVoices();
    voiceSelect.innerHTML = voices
      .map((v, idx) => `<option value="${idx}">${v.name} (${v.lang})</option>`)
      .join('');
  }
  if ('speechSynthesis' in window) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  function speak(text) {
    if (!('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const chosen = voices[parseInt(voiceSelect.value, 10)];
    if (chosen) u.voice = chosen;
    u.rate = parseFloat(rateInput.value || '1');
    u.pitch = parseFloat(pitchInput.value || '1');
    window.speechSynthesis.speak(u);
  }

  rateInput.addEventListener('input', () => {
    document.getElementById('rateVal').textContent = rateInput.value;
  });
  pitchInput.addEventListener('input', () => {
    document.getElementById('pitchVal').textContent = pitchInput.value;
  });
  document.getElementById('previewVoiceBtn').addEventListener('click', () => {
    speak('Systems online. FRIDAY voice output is active and ready.');
  });
  document.getElementById('stopVoiceBtn').addEventListener('click', () => {
    window.speechSynthesis?.cancel();
  });
  document.getElementById('stopSpeakBtn').addEventListener('click', () => {
    window.speechSynthesis?.cancel();
  });

  // Voice Input (Web Speech API)
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const sttInfo = document.getElementById('sttSupportInfo');
  const micBtn = document.getElementById('micBtn');
  let recognition = null;
  if (SpeechRec) {
    sttInfo.textContent = 'Web Speech API available. Click the microphone in Conversation to speak.';
    recognition = new SpeechRec();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      document.getElementById('chatInput').value = transcript;
      micBtn.classList.remove('listening');
    };
    recognition.onerror = () => micBtn.classList.remove('listening');
    recognition.onend = () => micBtn.classList.remove('listening');
    micBtn.addEventListener('click', () => {
      micBtn.classList.add('listening');
      recognition.start();
    });
  } else {
    sttInfo.textContent = 'Web Speech API is not supported in this browser.';
    micBtn.disabled = true;
  }

  // Chat
  const chatMessages = document.getElementById('chatMessages');
  function appendMessage(role, text, meta = '') {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = text;
    if (meta) {
      const m = document.createElement('div');
      m.className = 'msg-meta';
      m.textContent = meta;
      div.appendChild(m);
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  async function sendPrompt(text) {
    appendMessage('user', text);
    try {
      const res = await api('/friday/run', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      const reply = res.output || res.error || 'Done.';
      appendMessage('assistant', reply, `${res.executor} · ${res.durationMs}ms`);
      refreshAll();
    } catch (err) {
      appendMessage('assistant', `Error: ${err.message}`);
    }
  }

  document.getElementById('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendPrompt(text);
  });

  document.querySelectorAll('.quick-actions .btn-sm').forEach((btn) => {
    btn.addEventListener('click', () => sendPrompt(btn.dataset.prompt));
  });

  // Loaders
  async function loadHealth() {
    try {
      const [health, ollama] = await Promise.all([api('/friday/health'), api('/friday/ollama/status')]);
      document.getElementById('statUptime').textContent = `Uptime: ${health.uptime_seconds}s`;
      document.getElementById('statModel').textContent = ollama.configuredModel || 'qwen3:4b';
      document.getElementById('sidebarModel').textContent = `Model: ${ollama.configuredModel || 'qwen3:4b'}`;

      const ollamaChip = document.getElementById('chipOllama');
      ollamaChip.textContent = `Ollama: ${ollama.reachable ? 'Online' : 'Offline'}`;
      ollamaChip.className = `chip ${ollama.reachable ? 'ok' : 'err'}`;

      const clawChip = document.getElementById('chipClaw');
      const clawOnline = health.subsystems?.claw?.exists;
      clawChip.textContent = `Claw: ${clawOnline ? 'Online' : 'Offline'}`;
      clawChip.className = `chip ${clawOnline ? 'ok' : 'err'}`;
    } catch {
      // Ignore transient errors
    }
  }

  async function loadWatchers() {
    const [{ watchers }, { history }] = await Promise.all([
      api('/friday/watchers'),
      api('/friday/watchers/history?limit=15'),
    ]);
    const active = watchers.filter((w) => w.status === 'active');
    const degraded = active.filter((w) => w.health !== 'healthy');
    document.getElementById('statWatchers').textContent = String(active.length);
    document.getElementById('navWatcherCount').textContent = String(active.length);
    document.getElementById('statWatcherHealth').textContent =
      degraded.length > 0 ? `${degraded.length} degraded/offline` : 'All healthy';

    const listEl = document.getElementById('watchersList');
    listEl.innerHTML = watchers.length
      ? watchers
          .map(
            (w) => `
          <div class="list-item">
            <div>
              <div class="list-item-title">${w.name} <span class="pill ${w.status}">${w.status}</span> <span class="pill ${w.health}">${w.health}</span></div>
              <div class="list-item-sub">${w.targetUrl} · ${w.method} · every ${Math.round(w.intervalMs / 1000)}s · worker: ${w.workerRunning ? 'running' : 'stopped'}</div>
            </div>
            <div class="item-actions">
              ${w.status === 'active'
                ? `<button class="btn-sm" onclick="window.__pauseWatcher('${w.id}')">Pause</button>`
                : `<button class="btn-sm" onclick="window.__resumeWatcher('${w.id}')">Resume</button>`}
              <button class="btn-sm" onclick="window.__stopWatcher('${w.id}')">Stop</button>
              <button class="btn-sm" onclick="window.__deleteWatcher('${w.id}')">Delete</button>
            </div>
          </div>`
          )
          .join('')
      : '<div class="hint">No watchers configured yet.</div>';

    document.getElementById('watcherHistoryList').innerHTML = history.length
      ? history
          .map(
            (h) => `
          <div class="list-item">
            <div>
              <div class="list-item-title">${h.watcher_name} <span class="pill ${h.status}">${h.status}</span></div>
              <div class="list-item-sub">${h.message} · ${h.latency_ms}ms · ${h.checked_at}</div>
            </div>
          </div>`
          )
          .join('')
      : '<div class="hint">No check history yet.</div>';
  }

  window.__pauseWatcher = async (id) => { await api(`/friday/watchers/${id}/pause`, { method: 'POST' }); loadWatchers(); };
  window.__resumeWatcher = async (id) => { await api(`/friday/watchers/${id}/resume`, { method: 'POST' }); loadWatchers(); };
  window.__stopWatcher = async (id) => { await api(`/friday/watchers/${id}/stop`, { method: 'POST' }); loadWatchers(); };
  window.__deleteWatcher = async (id) => { await api(`/friday/watchers/${id}`, { method: 'DELETE' }); loadWatchers(); };

  document.getElementById('watcherForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/friday/watchers', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('watcherName').value,
        targetUrl: document.getElementById('watcherUrl').value,
        method: document.getElementById('watcherMethod').value,
        intervalMs: parseInt(document.getElementById('watcherInterval').value || '60', 10) * 1000,
      }),
    });
    e.target.reset();
    loadWatchers();
  });
  document.getElementById('refreshWatchersBtn').addEventListener('click', loadWatchers);

  async function loadReminders() {
    const { reminders } = await api('/friday/reminders');
    const pending = reminders.filter((r) => r.status === 'pending');
    document.getElementById('statReminders').textContent = String(pending.length);
    document.getElementById('navReminderCount').textContent = String(pending.length);

    document.getElementById('remindersList').innerHTML = reminders.length
      ? reminders
          .map(
            (r) => `
          <div class="list-item">
            <div>
              <div class="list-item-title">${r.isAlarm ? '⏰ ' : ''}${r.title} <span class="pill ${r.status === 'pending' ? 'active' : 'healthy'}">${r.status}</span></div>
              <div class="list-item-sub">${r.dueAt || 'Location trigger'} · ${r.recurrence} · ${r.timezone}</div>
            </div>
            <div class="item-actions">
              ${r.status === 'pending' ? `<button class="btn-sm" onclick="window.__completeRem('${r.id}')">Complete</button>` : ''}
              <button class="btn-sm" onclick="window.__deleteRem('${r.id}')">Delete</button>
            </div>
          </div>`
          )
          .join('')
      : '<div class="hint">No reminders scheduled.</div>';
  }
  window.__completeRem = async (id) => { await api(`/friday/reminders/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'completed' }) }); loadReminders(); };
  window.__deleteRem = async (id) => { await api(`/friday/reminders/${id}`, { method: 'DELETE' }); loadReminders(); };

  document.getElementById('reminderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dueRaw = document.getElementById('remDueAt').value;
    await api('/friday/reminders', {
      method: 'POST',
      body: JSON.stringify({
        title: document.getElementById('remTitle').value,
        dueAt: dueRaw ? new Date(dueRaw).toISOString() : null,
        recurrence: document.getElementById('remRecurrence').value,
        isAlarm: document.getElementById('remIsAlarm').checked,
      }),
    });
    e.target.reset();
    loadReminders();
  });
  document.getElementById('refreshRemindersBtn').addEventListener('click', loadReminders);

  async function loadNotifications() {
    const { notifications } = await api('/friday/notifications');
    const unread = notifications.filter((n) => !n.isRead);
    document.getElementById('navNotifCount').textContent = String(unread.length);

    document.getElementById('notificationsList').innerHTML = notifications.length
      ? notifications
          .map(
            (n) => `
          <div class="list-item">
            <div>
              <div class="list-item-title">${n.title} <span class="pill ${n.severity}">${n.severity}</span> ${n.isRead ? '' : '<span class="pill warning">UNREAD</span>'}</div>
              <div class="list-item-sub">${n.message} · ${n.createdAt}</div>
            </div>
            <div class="item-actions">
              ${!n.isRead ? `<button class="btn-sm" onclick="window.__readNotif('${n.id}')">Mark Read</button>` : ''}
            </div>
          </div>`
          )
          .join('')
      : '<div class="hint">No notifications yet.</div>';
  }
  window.__readNotif = async (id) => { await api(`/friday/notifications/${id}/read`, { method: 'POST' }); loadNotifications(); };
  document.getElementById('markAllReadBtn').addEventListener('click', async () => {
    await api('/friday/notifications/read-all', { method: 'POST' });
    loadNotifications();
  });

  async function loadMemories(query = '') {
    const url = query ? `/friday/memory/search?q=${encodeURIComponent(query)}` : '/friday/memory/retrieve?limit=30';
    const { results } = await api(url);
    document.getElementById('memoriesList').innerHTML = results.length
      ? results
          .map(
            (m) => `
          <div class="list-item">
            <div>
              <div class="list-item-title">[${m.type}] ${m.key}</div>
              <div class="list-item-sub">${m.value}</div>
            </div>
            <button class="btn-sm" onclick="window.__deleteMemory('${m.id}')">Delete</button>
          </div>`
          )
          .join('')
      : '<div class="hint">No stored memories.</div>';
  }
  window.__deleteMemory = async (id) => { await api(`/friday/memory/${id}`, { method: 'DELETE' }); loadMemories(); };
  document.getElementById('memoryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/friday/memory/store', {
      method: 'POST',
      body: JSON.stringify({
        type: document.getElementById('memType').value,
        key: document.getElementById('memKey').value,
        value: document.getElementById('memValue').value,
      }),
    });
    e.target.reset();
    loadMemories();
  });
  document.getElementById('memSearchInput').addEventListener('input', (e) => loadMemories(e.target.value));

  async function loadSettings() {
    const [{ profile }, { devices }, { logs }] = await Promise.all([
      api('/friday/personality'),
      api('/friday/auth/devices'),
      api('/friday/audit?limit=20'),
    ]);

    const hour = new Date().getHours();
    const salutation = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const namePart = profile.userName && profile.userName !== 'User' ? `, ${profile.userName}` : '';
    document.getElementById('greetingTitle').textContent = `${salutation}${namePart}.`;

    document.getElementById('profUserName').value = profile.userName;
    document.getElementById('profFormality').value = profile.formality;
    document.getElementById('profHumor').value = profile.humor;
    document.getElementById('profVerbosity').value = profile.verbosity;
    document.getElementById('profTimezone').value = profile.timezone;

    document.getElementById('chipDevices').textContent = `Devices: ${devices.length}`;
    document.getElementById('statDevicesSub').textContent = `${devices.length} paired device(s)`;

    document.getElementById('devicesList').innerHTML = devices.length
      ? devices
          .map(
            (d) => `
          <div class="list-item">
            <div>
              <div class="list-item-title">${d.name} (${d.platform})</div>
              <div class="list-item-sub">Location opt-in: ${d.locationOptIn} · Last seen: ${d.lastSeenAt}</div>
            </div>
            <button class="btn-sm" onclick="window.__revokeDevice('${d.id}')">Revoke</button>
          </div>`
          )
          .join('')
      : '<div class="hint">No paired companion devices.</div>';

    document.getElementById('auditLogsList').innerHTML = logs.length
      ? logs
          .map(
            (l) => `
          <div class="list-item">
            <div>
              <div class="list-item-title">${l.action} <span class="pill ${l.success ? 'healthy' : 'critical'}">${l.risk}</span></div>
              <div class="list-item-sub">${l.actor} · ${l.details || l.resource} · ${l.createdAt}</div>
            </div>
          </div>`
          )
          .join('')
      : '<div class="hint">No audit records yet.</div>';
  }

  window.__revokeDevice = async (id) => { await api(`/friday/auth/devices/${id}`, { method: 'DELETE' }); loadSettings(); };

  document.getElementById('personalityForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/friday/personality', {
      method: 'PUT',
      body: JSON.stringify({
        userName: document.getElementById('profUserName').value,
        formality: document.getElementById('profFormality').value,
        humor: document.getElementById('profHumor').value,
        verbosity: document.getElementById('profVerbosity').value,
        timezone: document.getElementById('profTimezone').value,
      }),
    });
    loadSettings();
  });

  document.getElementById('genPairCodeBtn').addEventListener('click', async () => {
    const res = await api('/friday/auth/pair-code', { method: 'POST' });
    const box = document.getElementById('pairCodeDisplay');
    box.classList.remove('hidden');
    box.textContent = `Pairing Code: ${res.code} (expires ${new Date(res.expiresAt).toLocaleTimeString()})`;
  });

  document.getElementById('backupDbBtn').addEventListener('click', async () => {
    const res = await api('/friday/backup', { method: 'POST' });
    document.getElementById('backupStatus').textContent = `Saved to ${res.path}`;
  });

  // JARVIS Execution & Presentation State (deduplication + out-of-order protection)
  const seenEvents = new Set();
  const taskProgressWatermark = new Map();
  let activeTaskId = null;

  function statusClass(status) {
    return String(status || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  }

  function renderExecutionOverview(task, steps = []) {
    if (!task) return;
    activeTaskId = task.id;
    document.getElementById('execTaskTitle').textContent = task.originalRequest || 'Background Task';
    document.getElementById('execTaskId').textContent = task.id;
    const pill = document.getElementById('execStatusPill');
    pill.textContent = task.status;
    pill.className = `pill ${statusClass(task.status)}`;

    const pct = Math.max(0, Math.min(100, Number(task.progress || 0)));
    document.getElementById('execProgressFill').style.width = `${pct}%`;
    document.getElementById('execProgressTrack').setAttribute('aria-valuenow', String(pct));

    const started = task.startedAt ? new Date(task.startedAt).toLocaleTimeString() : '--';
    const dur =
      task.startedAt && task.completedAt
        ? `${Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt))}ms`
        : task.status;
    document.getElementById('execTiming').textContent = `${started} · ${dur}`;

    const runningStep = steps.find((s) => s.status === 'RUNNING' || s.status === 'WAITING_FOR_APPROVAL');
    document.getElementById('execCurrentStep').textContent = runningStep
      ? `${runningStep.capabilityId} (${runningStep.status})`
      : `${steps.filter((s) => s.status === 'COMPLETED').length}/${steps.length} steps`;

    const traceList = document.getElementById('execTraceList');
    traceList.textContent = '';
    if (!steps.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = 'No steps recorded yet.';
      traceList.appendChild(empty);
      return;
    }

    for (const step of steps) {
      const row = document.createElement('div');
      row.className = 'trace-item';

      const left = document.createElement('div');
      left.textContent = `${step.executionOrder + 1}. ${step.capabilityId}`;
      if (Array.isArray(step.dependencies) && step.dependencies.length > 0) {
        const dep = document.createElement('span');
        dep.className = 'hint';
        dep.textContent = ` (after ${step.dependencies.join(', ')})`;
        left.appendChild(dep);
      }

      const right = document.createElement('span');
      right.className = `pill ${statusClass(step.status)}`;
      right.textContent = step.status;

      row.appendChild(left);
      row.appendChild(right);
      traceList.appendChild(row);
    }
  }

  function renderPresentationCards(presentations) {
    const container = document.getElementById('presentationCards');
    container.textContent = '';

    if (!presentations || !presentations.length) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'Verified result cards, metrics, tables, charts, and approvals will appear here.';
      container.appendChild(hint);
      return;
    }

    for (const p of presentations) {
      const card = document.createElement('article');
      card.className = 'pres-card';

      const head = document.createElement('div');
      head.className = 'pres-card-head';

      const title = document.createElement('div');
      title.className = 'pres-title';
      title.textContent = `[${String(p.presentationType).toUpperCase()}] ${p.title}`;

      const badge = document.createElement('span');
      badge.className = `pill ${statusClass(p.verificationStatus)}`;
      badge.textContent = p.verificationStatus;

      head.appendChild(title);
      head.appendChild(badge);
      card.appendChild(head);

      const summary = document.createElement('div');
      summary.className = 'pres-summary';
      summary.textContent = p.summary;
      card.appendChild(summary);

      const data = p.data || {};
      if (p.presentationType === 'metric' && Array.isArray(data.metrics)) {
        const grid = document.createElement('div');
        grid.className = 'pres-metrics';
        for (const m of data.metrics) {
          const box = document.createElement('div');
          box.className = 'pres-metric-box';
          const lbl = document.createElement('div');
          lbl.className = 'pres-metric-label';
          lbl.textContent = String(m.label || 'Metric');
          const val = document.createElement('div');
          val.className = 'pres-metric-val';
          val.textContent = `${m.value ?? '--'}${m.unit ? ` ${m.unit}` : ''}`;
          box.appendChild(lbl);
          box.appendChild(val);
          grid.appendChild(box);
        }
        card.appendChild(grid);
      } else if (p.presentationType === 'table' && Array.isArray(data.rows)) {
        const wrap = document.createElement('div');
        wrap.className = 'pres-table-wrap';
        const table = document.createElement('table');
        table.className = 'pres-table';
        const cols = Array.isArray(data.columns) ? data.columns : [];
        if (cols.length) {
          const thead = document.createElement('thead');
          const tr = document.createElement('tr');
          for (const c of cols) {
            const th = document.createElement('th');
            th.textContent = String(c);
            tr.appendChild(th);
          }
          thead.appendChild(tr);
          table.appendChild(thead);
        }
        const tbody = document.createElement('tbody');
        for (const r of data.rows.slice(0, 10)) {
          const tr = document.createElement('tr');
          for (const c of cols) {
            const td = document.createElement('td');
            td.textContent = r && r[c] !== undefined ? String(r[c]) : '';
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        card.appendChild(wrap);
      } else if (p.presentationType === 'chart' && Array.isArray(data.labels) && Array.isArray(data.values)) {
        const chart = document.createElement('div');
        chart.className = 'pres-chart';
        const numericVals = data.values.map((v) => Number(v) || 0);
        const maxVal = Math.max(1, ...numericVals);
        for (let i = 0; i < data.labels.length; i++) {
          const row = document.createElement('div');
          row.className = 'pres-chart-row';
          const lbl = document.createElement('span');
          lbl.textContent = String(data.labels[i]);
          const bg = document.createElement('div');
          bg.className = 'pres-chart-bar-bg';
          const bar = document.createElement('div');
          bar.className = 'pres-chart-bar';
          bar.style.width = `${Math.round((numericVals[i] / maxVal) * 100)}%`;
          bg.appendChild(bar);
          const val = document.createElement('span');
          val.className = 'mono';
          val.textContent = String(numericVals[i]);
          row.appendChild(lbl);
          row.appendChild(bg);
          row.appendChild(val);
          chart.appendChild(row);
        }
        card.appendChild(chart);
      }

      if (Array.isArray(p.provenance) && p.provenance.length > 0) {
        const prov = document.createElement('div');
        prov.className = 'pres-prov';
        const firstProv = p.provenance[0];
        prov.textContent = `Source: ${firstProv.sourceName} · ${firstProv.freshnessLabel}`;
        card.appendChild(prov);
      }

      if (Array.isArray(p.actions) && p.actions.length > 0) {
        const actRow = document.createElement('div');
        actRow.className = 'btn-group';
        for (const act of p.actions) {
          if (!act.approvalId) continue;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = act.kind === 'approve' ? 'btn-primary' : 'btn-sm';
          btn.textContent = act.label;
          btn.addEventListener('click', async () => {
            const endpoint = act.kind === 'approve' ? 'approve' : 'reject';
            await api(`/friday/approvals/${act.approvalId}/${endpoint}`, {
              method: 'POST',
              body: JSON.stringify({}),
            });
            loadTasksAndPresentations();
          });
          actRow.appendChild(btn);
        }
        card.appendChild(actRow);
      }

      container.appendChild(card);
    }
  }

  async function loadTasksAndPresentations() {
    try {
      const [{ tasks }, { presentations }] = await Promise.all([
        api('/friday/tasks?limit=10'),
        api('/friday/presentations?limit=10'),
      ]);
      if (tasks && tasks.length > 0) {
        const targetTask = tasks.find((t) => t.id === activeTaskId) || tasks[0];
        const detail = await api(`/friday/tasks/${targetTask.id}`);
        renderExecutionOverview(detail.task, detail.steps || []);
      }
      renderPresentationCards(presentations || []);
    } catch {
      // Ignore transient load errors
    }
  }

  document.getElementById('refreshPresentationsBtn').addEventListener('click', loadTasksAndPresentations);

  // WebSocket live updates
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/friday/ws`);
    const pill = document.getElementById('wsPill');
    ws.onopen = () => {
      pill.innerHTML = '<span class="dot online"></span> Connected';
      loadTasksAndPresentations();
    };
    ws.onclose = () => {
      pill.innerHTML = '<span class="dot"></span> Reconnecting…';
      setTimeout(connectWs, 3000);
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'notification:new') {
          loadNotifications();
          if (document.getElementById('autoSpeakAlerts').checked && msg.payload?.severity === 'critical') {
            speak(`Alert: ${msg.payload.title}. ${msg.payload.message}`);
          }
        } else if (msg.type === 'watcher:updated') {
          loadWatchers();
        } else if (msg.type === 'reminder:triggered') {
          loadReminders();
          loadNotifications();
        } else if (msg.type === 'task:event' && msg.payload?.taskId) {
          const evKey = `${msg.payload.taskId}:${msg.payload.eventType}:${msg.payload.timestamp}:${msg.payload.stepId || ''}`;
          if (seenEvents.has(evKey)) return;
          seenEvents.add(evKey);

          const prevPct = taskProgressWatermark.get(msg.payload.taskId) ?? -1;
          const nextPct = Number(msg.payload.progress ?? 0);
          if (nextPct < prevPct && msg.payload.status === 'RUNNING') return;
          taskProgressWatermark.set(msg.payload.taskId, nextPct);

          activeTaskId = msg.payload.taskId;
          loadTasksAndPresentations();
        } else if (msg.type === 'presentation:event') {
          loadTasksAndPresentations();
        }
      } catch {
        // Ignore malformed WS message
      }
    };
  }

  function refreshAll() {
    loadHealth();
    loadWatchers();
    loadReminders();
    loadNotifications();
    loadMemories();
    loadSettings();
    loadTasksAndPresentations();
    loadFinanceOverview();
  }

  // Financial Intelligence UI
  async function loadFinanceOverview() {
    const container = document.getElementById('financeOverviewGrid');
    const details = document.getElementById('financeDetailsGrid');
    if (!container || !details) return;
    try {
      const report = await api('/friday/finance/overview');
      const cur = report.currency || 'INR';

      const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      setText('finNetWorth', `${cur} ${report.netWorthFormatted}`);
      setText('finCashFlow', `${cur} ${report.cashFlow.netCashFlowFormatted}`);
      setText('finCashFlowSub', `In: ${report.cashFlow.totalIncomeFormatted} · Out: ${report.cashFlow.totalExpenseFormatted}`);
      setText('finPortfolioVal', `${cur} ${report.portfolio.totalValueFormatted}`);
      setText('finDebtVal', `${cur} ${report.totalDebtRemainingFormatted}`);

      const renderList = (elId, items, emptyMsg, fmt) => {
        const el = document.getElementById(elId);
        if (!el) return;
        el.textContent = '';
        if (!items || !items.length) {
          const hint = document.createElement('div');
          hint.className = 'hint';
          hint.textContent = emptyMsg;
          el.appendChild(hint);
          return;
        }
        for (const item of items) {
          const row = document.createElement('div');
          row.className = 'list-item';
          const left = document.createElement('div');
          const title = document.createElement('div');
          title.className = 'list-item-title';
          title.textContent = fmt.title(item);
          const sub = document.createElement('div');
          sub.className = 'list-item-sub';
          sub.textContent = fmt.sub(item);
          left.appendChild(title);
          left.appendChild(sub);
          const badge = document.createElement('span');
          badge.className = 'pill info';
          badge.textContent = item.sourceClassification || 'USER_ENTERED';
          row.appendChild(left);
          row.appendChild(badge);
          el.appendChild(row);
        }
      };

      renderList(
        'finBudgetsList',
        report.budgets,
        'No budgets set for this month. Add a category budget below to track utilization.',
        {
          title: (b) => `${b.category.toUpperCase()} (${b.utilizationPct}%)`,
          sub: (b) => `${b.currency} ${b.spentFormatted} / ${b.limitFormatted}${b.overBudget ? ' · OVER BUDGET' : ''}`,
        }
      );

      renderList(
        'finGoalsList',
        report.goals,
        'No savings goals yet. Create a goal to track target progress.',
        {
          title: (g) => `${g.name} (${g.progressPct}%)`,
          sub: (g) => `${g.currency} ${g.currentFormatted} / ${g.targetFormatted} · Est. ${g.estimatedMonthsToGoal ?? 'N/A'} mo`,
        }
      );

      renderList(
        'finDebtsList',
        report.debts,
        'No debts recorded. Add any loan or liability to project repayment.',
        {
          title: (d) => `${d.name} (${d.aprPct}% APR)`,
          sub: (d) => `Remaining ${d.currency} ${d.remainingFormatted} · Min ${d.minPaymentFormatted}/mo`,
        }
      );

      renderList(
        'finHoldingsList',
        report.portfolio.allocationByAssetClass.map((a) => ({
          ...a,
          sourceClassification: report.portfolio.hasUnverifiedOrStaleData ? 'ESTIMATED' : 'USER_ENTERED',
        })),
        'No portfolio holdings recorded. Add holdings to analyze asset allocation.',
        {
          title: (a) => `${a.assetClass.toUpperCase()} (${a.sharePct}%)`,
          sub: (a) => `${cur} ${a.valueFormatted}`,
        }
      );
    } catch {
      // Ignore transient finance load errors
    }
  }

  const finTxForm = document.getElementById('finTxForm');
  if (finTxForm) {
    finTxForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await api('/friday/finance/transactions', {
        method: 'POST',
        body: JSON.stringify({
          txType: document.getElementById('finTxType').value,
          category: document.getElementById('finTxCategory').value,
          amount: document.getElementById('finTxAmount').value,
          description: document.getElementById('finTxDesc').value,
          sourceClassification: 'USER_ENTERED',
        }),
      });
      finTxForm.reset();
      loadFinanceOverview();
    });
  }

  connectWs();
  refreshAll();
  setInterval(loadHealth, 15000);
})();
