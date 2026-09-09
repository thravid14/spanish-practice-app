// Local persistence layer. Everything lives in localStorage — no backend,
// per the spec. Swap this module out later if IndexedDB or Supabase sync
// is ever needed; nothing outside this file should touch localStorage directly.

const KEYS = {
  SETTINGS: 'sp_settings_v1',
  CONVERSATIONS: 'sp_conversations_v1',
};

const DEFAULT_SETTINGS = {
  apiKey: '',
  difficulty: 'intermediate', // beginner | intermediate | advanced
  dialect: 'es-ES', // es-ES | es-MX
};

function getSettings() {
  try {
    const raw = localStorage.getItem(KEYS.SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (err) {
    console.error('Failed to read settings, using defaults', err);
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(partial) {
  const next = { ...getSettings(), ...partial };
  localStorage.setItem(KEYS.SETTINGS, JSON.stringify(next));
  return next;
}

function getConversations() {
  try {
    const raw = localStorage.getItem(KEYS.CONVERSATIONS);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read conversations', err);
    return [];
  }
}

function saveConversations(list) {
  localStorage.setItem(KEYS.CONVERSATIONS, JSON.stringify(list));
}

function createConversation(scenarioId, difficulty) {
  const conv = {
    id: 'conv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    scenario: scenarioId,
    difficulty,
    startedAt: new Date().toISOString(),
    messages: [], // { speaker: 'user' | 'ai', text, timestamp, correction? }
  };
  const list = getConversations();
  list.unshift(conv);
  saveConversations(list);
  return conv;
}

function getConversation(id) {
  return getConversations().find((c) => c.id === id) || null;
}

function appendMessage(conversationId, message) {
  const list = getConversations();
  const conv = list.find((c) => c.id === conversationId);
  if (!conv) return null;
  conv.messages.push(message);
  saveConversations(list);
  return conv;
}

window.Storage = {
  getSettings,
  saveSettings,
  getConversations,
  createConversation,
  getConversation,
  appendMessage,
};
