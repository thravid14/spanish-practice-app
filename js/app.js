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
}

function init() {
  cacheEls();
  renderScenarioGrid();
  renderHomeStats();
  wireEvents();
  refreshApiKeyBanner();
  showView('home');
}

function wireEvents() {
  els.settingsBtn.addEventListener('click', openSettings);
  els.apiKeyBannerBtn.addEventListener('click', openSettings);
  els.settingsCancelBtn.addEventListener('click', closeSettings);
  els.settingsForm.addEventListener('submit', onSettingsSubmit);
  els.backBtn.addEventListener('click', () => showView('home'));
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
  els.settingsDialog.showModal();
}

function closeSettings() {
  els.settingsDialog.close();
}

function onSettingsSubmit(e) {
  e.preventDefault();
  Storage.saveSettings({
    apiKey: els.apiKeyInput.value.trim(),
    difficulty: els.difficultySelect.value,
    dialect: els.dialectSelect.value,
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
    const result = await Gemini.sendTurn(settings.apiKey, systemPrompt, historyForApi, text);
    typingEl.remove();

    const aiMessage = {
      speaker: 'ai',
      text: result.reply,
      translation: result.translation || '',
      timestamp: new Date().toISOString(),
      correction: result.hasCorrection ? result.correction : null,
    };
    activeConversation = Storage.appendMessage(activeConversation.id, aiMessage);
    appendMessageToDom(aiMessage);
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
  els.composerInput.disabled = value;
}

function appendMessageToDom(message) {
  const wrap = document.createElement('div');
  wrap.className = `message message--${message.speaker}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.text;
  wrap.appendChild(bubble);

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
