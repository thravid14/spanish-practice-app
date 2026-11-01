// App shell: view switching, settings, and the conversation loop.
// No framework, no build step — just DOM wiring.

const els = {};
let activeConversation = null;
let sending = false;

function cacheEls() {
  els.viewHome = document.getElementById('view-home');
  els.viewConversation = document.getElementById('view-conversation');
  els.scenarioGrid = document.getElementById('scenario-grid');
  els.statConversations = document.getElementById('stat-conversations');
  els.statMessages = document.getElementById('stat-messages');

  els.settingsBtn = document.getElementById('settings-btn');
  els.settingsDialog = document.getElementById('settings-dialog');
  els.settingsForm = document.getElementById('settings-form');
  els.apiKeyInput = document.getElementById('api-key-input');
  els.difficultySelect = document.getElementById('difficulty-select');
  els.dialectSelect = document.getElementById('dialect-select');
  els.settingsCancelBtn = document.getElementById('settings-cancel-btn');
  els.apiKeyBanner = document.getElementById('api-key-banner');
  els.apiKeyBannerBtn = document.getElementById('api-key-banner-btn');

  els.backBtn = document.getElementById('back-btn');
  els.convPersona = document.getElementById('conv-persona');
  els.convDifficultyBadge = document.getElementById('conv-difficulty-badge');
  els.messageList = document.getElementById('message-list');
  els.composerForm = document.getElementById('composer-form');
  els.composerInput = document.getElementById('composer-input');
  els.sendBtn = document.getElementById('send-btn');
  els.micBtn = document.getElementById('mic-btn');
  els.voiceStatus = document.getElementById('voice-status');
  els.speakRepliesInput = document.getElementById('speak-replies-input');
  els.voiceSpeedSelect = document.getElementById('voice-speed-select');
}

function init() {
  cacheEls();
  renderScenarioGrid();
  renderHomeStats();
  wireEvents();
  els.micBtn.hidden = !Voice.supportsRecognition;
  refreshApiKeyBanner();
  showView('home');
}

function wireEvents() {
  els.settingsBtn.addEventListener('click', openSettings);
  els.apiKeyBannerBtn.addEventListener('click', openSettings);
  els.settingsCancelBtn.addEventListener('click', closeSettings);
  els.settingsForm.addEventListener('submit', onSettingsSubmit);
  els.backBtn.addEventListener('click', () => {
    Voice.stopListening();
    Voice.cancelSpeech();
    showView('home');
  });
  els.micBtn.addEventListener('click', onMicClick);
  els.composerForm.addEventListener('submit', onComposerSubmit);

  els.composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      els.composerForm.requestSubmit();
    }
  });
}

function showView(name) {
  els.viewHome.hidden = name !== 'home';
  els.viewConversation.hidden = name !== 'conversation';
  if (name === 'home') {
    renderHomeStats();
    refreshApiKeyBanner();
  }
}

// ---------- Home ----------

function renderScenarioGrid() {
  els.scenarioGrid.innerHTML = Scenarios.SCENARIOS.map((s) => `
    <button class="scenario-card" data-scenario-id="${s.id}" type="button">
      <span class="scenario-icon" aria-hidden="true">${s.icon}</span>
      <span class="scenario-label">${s.label}</span>
      <span class="scenario-blurb">${s.blurb}</span>
    </button>
  `).join('');

  els.scenarioGrid.querySelectorAll('.scenario-card').forEach((btn) => {
    btn.addEventListener('click', () => startConversation(btn.dataset.scenarioId));
  });
}

function renderHomeStats() {
  const conversations = Storage.getConversations();
  const totalMessages = conversations.reduce((sum, c) => sum + c.messages.filter((m) => m.speaker === 'user').length, 0);
  els.statConversations.textContent = String(conversations.length);
  els.statMessages.textContent = String(totalMessages);
}

function refreshApiKeyBanner() {
  const settings = Storage.getSettings();
  els.apiKeyBanner.hidden = Boolean(settings.apiKey);
}

// ---------- Settings ----------

function openSettings() {
  const settings = Storage.getSettings();
  els.apiKeyInput.value = settings.apiKey;
  els.difficultySelect.value = settings.difficulty;
  els.dialectSelect.value = settings.dialect;
  els.speakRepliesInput.checked = settings.speakReplies;
  els.voiceSpeedSelect.value = settings.voiceSpeed;
  els.settingsDialog.showModal();
}

function closeSettings() {
  els.settingsDialog.close();
}

function onSettingsSubmit(e) {
  e.preventDefault();
  const newKey = els.apiKeyInput.value.trim();
  Storage.saveSettings({
    // a different key may have access to different models, so re-detect
    ...(newKey !== Storage.getSettings().apiKey ? { model: '' } : {}),
    apiKey: newKey,
    difficulty: els.difficultySelect.value,
    dialect: els.dialectSelect.value,
    speakReplies: els.speakRepliesInput.checked,
    voiceSpeed: els.voiceSpeedSelect.value,
  });
  els.settingsDialog.close();
  refreshApiKeyBanner();
}

// ---------- Conversation ----------

function startConversation(scenarioId) {
  const scenario = Scenarios.SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) return;

  const settings = Storage.getSettings();
  if (!settings.apiKey) {
    openSettings();
    return;
  }

  activeConversation = Storage.createConversation(scenarioId, settings.difficulty);
  els.convPersona.textContent = `${scenario.icon} ${scenario.label}`;
  els.convDifficultyBadge.textContent = difficultyLabel(settings.difficulty);
  els.messageList.innerHTML = '';
  els.composerInput.value = '';
  setVoiceStatus('');
  showView('conversation');
  els.composerInput.focus();
}

function difficultyLabel(d) {
  return { beginner: 'Principiante', intermediate: 'Intermedio', advanced: 'Avanzado' }[d] || d;
}

async function onComposerSubmit(e) {
  e.preventDefault();
  if (sending) return;

  const text = els.composerInput.value.trim();
  if (!text || !activeConversation) return;

  Voice.cancelSpeech();
  setVoiceStatus('');

  const settings = Storage.getSettings();
  const scenario = Scenarios.SCENARIOS.find((s) => s.id === activeConversation.scenario);
  const systemPrompt = Scenarios.buildSystemPrompt(scenario, activeConversation.difficulty, settings.dialect);

  const userMessage = { speaker: 'user', text, timestamp: new Date().toISOString() };
  activeConversation = Storage.appendMessage(activeConversation.id, userMessage);
  appendMessageToDom(userMessage);
  els.composerInput.value = '';

  const historyForApi = activeConversation.messages.slice(0, -1); // exclude the turn we just added, it's passed separately
  setSending(true);
  const typingEl = appendTypingIndicator();

  try {
    const result = await Gemini.sendTurn(settings.apiKey, systemPrompt, historyForApi, text, settings.model);
    typingEl.remove();
    if (result.model !== settings.model) Storage.saveSettings({ model: result.model });

    const aiMessage = {
      speaker: 'ai',
      text: result.reply,
      translation: result.translation || '',
      timestamp: new Date().toISOString(),
      correction: result.hasCorrection ? result.correction : null,
    };
    activeConversation = Storage.appendMessage(activeConversation.id, aiMessage);
    appendMessageToDom(aiMessage);
    if (settings.speakReplies) Voice.speak(aiMessage.text, settings.dialect, settings.voiceSpeed);
  } catch (err) {
    typingEl.remove();
    appendErrorToDom(err.message || 'Ocurrió un error inesperado.');
    console.error(err);
  } finally {
    setSending(false);
  }
}

function setSending(value) {
  sending = value;
  els.sendBtn.disabled = value;
  els.micBtn.disabled = value;
  els.composerInput.disabled = value;
}

// ---------- Voice ----------

function setVoiceStatus(text) {
  els.voiceStatus.textContent = text;
  els.voiceStatus.hidden = !text;
}

function voiceErrorText(code) {
  return {
    'not-allowed': 'El micrófono está bloqueado. En Android: Ajustes → Apps → Chrome → Permisos → Micrófono, y permítelo también para este sitio en Chrome.',
    'service-not-allowed': 'El micrófono está bloqueado. En Android: Ajustes → Apps → Chrome → Permisos → Micrófono, y permítelo también para este sitio en Chrome.',
    'no-speech': 'No te escuché. Toca el micrófono e inténtalo otra vez.',
    'audio-capture': 'No se detecta ningún micrófono.',
    'network': 'El reconocimiento de voz necesita conexión a internet.',
  }[code] || `Error de voz (${code}).`;
}

function onMicClick() {
  if (Voice.isListening()) {
    Voice.stopListening();
    return;
  }
  if (sending || !activeConversation) return;

  Voice.cancelSpeech(); // don't let the mic hear the app's own voice
  const settings = Storage.getSettings();
  els.composerInput.value = '';
  let errored = false;

  els.micBtn.classList.add('mic-btn--listening');
  setVoiceStatus('🎙️ Escuchando… habla ahora');

  Voice.startListening(settings.dialect, {
    onInterim: (text) => { els.composerInput.value = text; },
    onFinal: (text) => {
      els.composerInput.value = text;
      els.composerForm.requestSubmit();
    },
    onError: (code) => {
      if (code === 'aborted') return;
      errored = true;
      setVoiceStatus(voiceErrorText(code));
    },
    onEnd: (heard) => {
      els.micBtn.classList.remove('mic-btn--listening');
      if (!heard && !errored) setVoiceStatus('No te escuché. Toca el micrófono e inténtalo otra vez.');
      else if (heard) setVoiceStatus('');
    },
  });
}

function appendMessageToDom(message) {
  const wrap = document.createElement('div');
  wrap.className = `message message--${message.speaker}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.text;

  if (message.speaker === 'ai' && Voice.supportsSynthesis) {
    const row = document.createElement('div');
    row.className = 'bubble-row';
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'speak-btn';
    replay.textContent = '🔊';
    replay.title = 'Escuchar de nuevo';
    replay.setAttribute('aria-label', 'Escuchar de nuevo');
    replay.addEventListener('click', () => {
      const current = Storage.getSettings();
      Voice.speak(message.text, current.dialect, current.voiceSpeed);
    });
    row.append(bubble, replay);
    wrap.appendChild(row);
  } else {
    wrap.appendChild(bubble);
  }

  if (message.speaker === 'ai' && message.translation) {
    const autoOpen = activeConversation && activeConversation.difficulty === 'beginner';
    wrap.appendChild(buildTranslationChip(message.translation, autoOpen));
  }

  if (message.correction) {
    wrap.appendChild(buildCorrectionChip(message.correction));
  }

  els.messageList.appendChild(wrap);
  els.messageList.scrollTop = els.messageList.scrollHeight;
}

function buildTranslationChip(translation, autoOpen) {
  const details = document.createElement('details');
  details.className = 'translation-chip';
  if (autoOpen) details.open = true;

  const summary = document.createElement('summary');
  summary.textContent = '🌐 Traducción / Translation';
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'translation-body';
  body.textContent = translation;
  details.appendChild(body);
  return details;
}

function buildCorrectionChip(correction) {
  const details = document.createElement('details');
  details.className = 'correction-chip';

  const summary = document.createElement('summary');
  summary.textContent = '✏️ Corrección disponible';
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'correction-body';
  body.innerHTML = `
    <div class="correction-row"><span class="correction-label">Dijiste</span><span class="correction-original">${escapeHtml(correction.originalText)}</span></div>
    <div class="correction-row"><span class="correction-label">Mejor así</span><span class="correction-fixed">${escapeHtml(correction.correctedText)}</span></div>
    ${correction.explanation ? `<p class="correction-explanation">${escapeHtml(correction.explanation)}</p>` : ''}
    ${correction.explanationEnglish ? `<p class="correction-explanation correction-explanation--en">${escapeHtml(correction.explanationEnglish)}</p>` : ''}
    ${correction.grammarTag ? `<span class="correction-tag">${escapeHtml(correction.grammarTag)}</span>` : ''}
  `;
  details.appendChild(body);
  return details;
}

function appendTypingIndicator() {
  const wrap = document.createElement('div');
  wrap.className = 'message message--ai message--typing';
  wrap.innerHTML = '<div class="bubble typing-dots"><span></span><span></span><span></span></div>';
  els.messageList.appendChild(wrap);
  els.messageList.scrollTop = els.messageList.scrollHeight;
  return wrap;
}

function appendErrorToDom(text) {
  const wrap = document.createElement('div');
  wrap.className = 'message message--error';
  wrap.innerHTML = `<div class="bubble bubble--error">⚠️ ${escapeHtml(text)}</div>`;
  els.messageList.appendChild(wrap);
  els.messageList.scrollTop = els.messageList.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', init);
