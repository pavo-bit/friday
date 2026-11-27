document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('chatForm');
  const input = document.getElementById('userInput');
  const chat = document.getElementById('chatContainer');
  const mic = document.getElementById('micButton');
  const toggle = document.getElementById('speakToggle');
  const voiceSelect = document.getElementById('voiceSelect');
  const voicePreview = document.getElementById('voicePreview');
  const voiceState = document.getElementById('voiceState');
  const voicePill = document.getElementById('voicePill');
  const voiceStatus = document.getElementById('voiceStatus');
  const voiceDetail = document.getElementById('voiceDetail');

  let speaking = true;
  let recognition = null;
  let listening = false;
  let availableVoices = [];
  let selectedVoice = null;

  const speechSupported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function state(message, kind = '') {
    voiceState.textContent = message;
    voiceState.className = 'voice-state' + (kind ? ' ' + kind : '');
  }

  function addMessage(text, role) {
    const row = document.createElement('div');
    row.className = 'message ' + role;
    const mark = document.createElement('span');
    mark.className = 'message-mark';
    mark.textContent = role === 'assistant' ? 'F' : 'Y';
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = (role === 'assistant' ? 'FRIDAY' : 'YOU') + ' · ' +
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    body.append(meta, bubble);
    row.append(mark, body);
    chat.append(row);
    chat.scrollTop = chat.scrollHeight;
    return bubble;
  }

  function populateVoices() {
    if (!speechSupported) {
      voiceSelect.innerHTML = '<option>Speech unavailable</option>';
      voiceSelect.disabled = true;
      voicePreview.disabled = true;
      voiceStatus.textContent = 'Unavailable';
      voiceDetail.textContent = 'Browser speech synthesis not supported';
      voicePill.textContent = 'NOT SUPPORTED';
      return;
    }
    availableVoices = window.speechSynthesis.getVoices();
    if (!availableVoices.length) {
      voiceSelect.innerHTML = '<option>Loading voices…</option>';
      return;
    }
    const previousName = selectedVoice && selectedVoice.name;
    voiceSelect.replaceChildren();
    availableVoices.forEach((voice, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = voice.name + ' · ' + voice.lang;
      voiceSelect.append(option);
    });
    const preferred = availableVoices.findIndex(v => /^en-IN$/i.test(v.lang)) >= 0
      ? availableVoices.findIndex(v => /^en-IN$/i.test(v.lang))
      : availableVoices.findIndex(v => /^en-(US|GB)/i.test(v.lang));
    const previous = availableVoices.findIndex(v => v.name === previousName);
    const chosen = previous >= 0 ? previous : Math.max(preferred, 0);
    voiceSelect.value = String(chosen);
    selectedVoice = availableVoices[chosen] || null;
    voiceStatus.textContent = 'Ready';
    voiceDetail.textContent = selectedVoice ? selectedVoice.name : 'System voice';
    voicePill.textContent = availableVoices.length + ' VOICES';
  }

  function speak(text) {
    if (!speaking || !speechSupported || !text.trim()) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 5000));
    utterance.voice = selectedVoice;
    utterance.lang = selectedVoice ? selectedVoice.lang : (navigator.language || 'en-IN');
    utterance.rate = 1;
    utterance.pitch = 0.96;
    utterance.onstart = () => state('FRIDAY is speaking…', 'listening');
    utterance.onend = () => state('Voice ready · click the microphone to speak');
    utterance.onerror = () => state('Speech playback unavailable on this device', 'error');
    window.speechSynthesis.speak(utterance);
  }

  function previewVoice() {
    if (!speechSupported || !selectedVoice) {
      state('No browser voice is available on this device', 'error');
      return;
    }
    window.speechSynthesis.cancel();
    const preview = new SpeechSynthesisUtterance("Hello. I'm FRIDAY, your personal AI assistant. How can I help you today?");
    preview.voice = selectedVoice;
    preview.lang = selectedVoice.lang;
    preview.rate = 0.95;
    preview.pitch = 0.96;
    preview.onstart = () => state('Previewing ' + selectedVoice.name, 'listening');
    preview.onend = () => state('Voice preview complete');
    preview.onerror = () => state('Voice preview failed', 'error');
    window.speechSynthesis.speak(preview);
  }

  if (speechSupported) {
    populateVoices();
    window.speechSynthesis.addEventListener('voiceschanged', populateVoices);
  } else {
    populateVoices();
  }

  voiceSelect.addEventListener('change', () => {
    selectedVoice = availableVoices[Number(voiceSelect.value)] || null;
    voiceDetail.textContent = selectedVoice ? selectedVoice.name : 'System voice';
    state('Voice selected · ' + (selectedVoice ? selectedVoice.name : 'system default'));
  });
  voicePreview.addEventListener('click', previewVoice);

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = navigator.language || 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => {
      listening = true;
      mic.classList.add('active');
      mic.textContent = '●';
      state('Listening… speak now', 'listening');
    };
    recognition.onresult = event => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
        else interimText += event.results[i][0].transcript;
      }
      if (finalText) input.value = (input.value + ' ' + finalText).trim();
      if (interimText) state('Hearing: ' + interimText, 'listening');
    };
    recognition.onerror = event => state('Microphone error: ' + event.error, 'error');
    recognition.onend = () => {
      listening = false;
      mic.classList.remove('active');
      mic.textContent = '⌁';
      if (!voiceState.classList.contains('error')) state('Voice ready · click the microphone to speak');
    };
    voiceDetail.textContent = speechSupported ? 'Mic input · spoken replies' : 'Mic input · speech output unavailable';
  } else {
    mic.disabled = true;
    mic.title = 'Speech recognition is not supported in this browser';
    state('Microphone transcription is unsupported here. Try Chrome or Edge.', 'error');
    voicePill.textContent = 'MIC UNSUPPORTED';
    voiceDetail.textContent = 'Speech output only · mic unavailable';
  }

  mic.addEventListener('click', () => {
    if (!recognition) return;
    try {
      if (listening) recognition.stop();
      else recognition.start();
    } catch {
      state('Microphone is busy. Try again.', 'error');
    }
  });

  toggle.addEventListener('click', () => {
    speaking = !speaking;
    toggle.classList.toggle('enabled', speaking);
    if (!speaking && speechSupported) window.speechSynthesis.cancel();
    state(speaking ? 'Spoken replies enabled' : 'Spoken replies muted');
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) return;
    addMessage(prompt, 'user');
    input.value = '';
    const pending = addMessage('Working on it…', 'assistant');
    document.getElementById('sendBtn').disabled = true;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.output || 'Request failed');
      pending.textContent = data.output || 'No response received.';
      speak(pending.textContent);
    } catch (error) {
      pending.textContent = 'Connection error: ' + error.message;
      state('Could not reach FRIDAY runtime', 'error');
    } finally {
      document.getElementById('sendBtn').disabled = false;
      input.focus();
      chat.scrollTop = chat.scrollHeight;
    }
  });

  document.querySelectorAll('.quick-prompt').forEach(button => {
    button.addEventListener('click', () => {
      input.value = button.dataset.prompt || '';
      input.focus();
      if (!input.value.endsWith(': ')) form.requestSubmit();
    });
  });
  document.getElementById('focusChat').addEventListener('click', () =>
    document.getElementById('conversation').scrollIntoView({ behavior: 'smooth' })
  );

  async function refreshStatus() {
    try {
      const response = await fetch('/api/health');
      const data = await response.json();
      const online = Boolean(data.ai_online);
      const configured = Boolean(data.ai_configured);
      document.getElementById('engineStatus').textContent = online ? 'Connected' : configured ? 'Offline' : 'Unconfigured';
      document.getElementById('engineDetail').textContent = online
        ? 'OpenRouter inference reachable'
        : configured
          ? 'OpenRouter endpoint unreachable'
          : 'Set OPENROUTER_API_KEY & OPENROUTER_MODEL';
      document.getElementById('enginePill').textContent = online ? 'ONLINE' : configured ? 'OFFLINE' : 'UNCONFIGURED';
      document.getElementById('modelName').textContent = data.model || 'unconfigured';
      document.getElementById('clawStatus').textContent = data.claw_binary ? 'Available' : 'Missing';
      document.getElementById('clawDetail').textContent = data.claw_binary
        ? 'Rust agent binary found' : 'Build with cargo build';
      document.getElementById('clawPill').textContent = data.claw_binary ? 'READY' : 'NOT BUILT';
      document.getElementById('aiAddress').textContent = data.ai_url || 'openrouter.ai/api/v1';
      document.getElementById('runtimeAddress').textContent = data.claw_binary
        ? 'Rust runtime ready' : 'Rust runtime not found';
      document.getElementById('aiDot').className = online ? 'good' : 'bad';
      document.getElementById('runtimeDot').className = data.claw_binary ? 'good' : 'bad';
    } catch {
      document.getElementById('engineStatus').textContent = 'Unavailable';
      document.getElementById('enginePill').textContent = 'API OFFLINE';
    }
  }

  function updateClock() {
    document.getElementById('clock').textContent = new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit'
    });
  }
  updateClock();
  setInterval(updateClock, 30000);
  refreshStatus();
  document.getElementById('refreshStatus').addEventListener('click', refreshStatus);
});
