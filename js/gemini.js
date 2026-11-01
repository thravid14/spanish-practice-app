// Thin wrapper around the Gemini API. Swappable later if the AI backend
// changes (see project memory: AI backend choice was left open on purpose).

const FALLBACK_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT_MS = 25000;
const MAX_MODEL_ATTEMPTS = 4;

class GeminiError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GeminiError';
    this.cause = cause;
  }
}

// Sends one request to one model. Returns { res } on any HTTP response, or
// { timedOut: true } if the model took too long. Network failures throw.
async function postGenerate(model, apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { res };
  } catch (err) {
    if (err.name === 'AbortError') return { timedOut: true };
    throw new GeminiError('No se pudo conectar con Gemini. Revisa tu conexión a internet.', err);
  } finally {
    clearTimeout(timer);
  }
}

// Asks Google which models this key can call. Returns Flash and Flash-Lite
// ids, fastest-first: Lite models before full Flash (a chat partner needs low
// latency, and the big ones can think for a long time), newest first within
// each group. Model names change over time and keys differ in what they can
// reach, so we discover rather than hardcode.
async function listCandidateModels(apiKey) {
  let res;
  try {
    res = await fetch(`${API_BASE}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`);
  } catch (err) {
    return [];
  }
  if (!res.ok) return [];

  const data = await res.json();
  const parse = (id) => {
    const m = id.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/);
    return m && { version: parseFloat(m[1]), lite: Boolean(m[2]) };
  };
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((id) => parse(id))
    .sort((a, b) => {
      const pa = parse(a), pb = parse(b);
      return (pb.lite - pa.lite) || (pb.version - pa.version);
    });
}

async function readErrorDetail(res) {
  try {
    return (await res.json())?.error?.message || '';
  } catch (_) {
    return '';
  }
}

/**
 * Tries models in turn until one answers. Moves on past a model that times
 * out, doesn't exist for this key (404), is out of quota (429), or errors on
 * Google's side (5xx); stops at errors that no other model would fix.
 *
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {{speaker: 'user'|'ai', text: string}[]} history - prior turns, oldest first
 * @param {string} userMessage - the new user turn to append
 * @param {string} [preferredModel] - last model known to work for this key
 * @returns {Promise<{reply: string, translation: string, hasCorrection: boolean, correction: object|null, model: string}>}
 */
async function sendTurn(apiKey, systemPrompt, history, userMessage, preferredModel) {
  if (!apiKey) {
    throw new GeminiError('Falta la clave de API de Gemini. Añádela en Ajustes.');
  }

  const contents = history.map((m) => ({
    role: m.speaker === 'user' ? 'user' : 'model',
    parts: [{ text: m.text }],
  }));
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.9,
    },
  };

  let candidates;
  if (preferredModel) {
    candidates = [preferredModel];
  } else {
    const discovered = await listCandidateModels(apiKey);
    candidates = discovered.length ? discovered : FALLBACK_MODELS;
  }

  const failures = [];
  for (let i = 0; i < candidates.length && failures.length < MAX_MODEL_ATTEMPTS; i++) {
    const model = candidates[i];
    const { res, timedOut } = await postGenerate(model, apiKey, body);

    if (timedOut) {
      failures.push(`${model}: sin respuesta en ${REQUEST_TIMEOUT_MS / 1000}s`);
    } else if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      if (text) return { ...parseModelJson(text), model };
      const blockReason = data?.promptFeedback?.blockReason;
      if (blockReason) throw new GeminiError(`Gemini bloqueó la respuesta (${blockReason}).`);
      failures.push(`${model}: respuesta vacía`);
    } else {
      const detail = await readErrorDetail(res);
      if (res.status === 400 && /API key/i.test(detail)) {
        throw new GeminiError('La clave de API no es válida. Revísala en Ajustes.');
      }
      const skippable = res.status === 404 || res.status === 429 || res.status >= 500;
      if (!skippable) {
        throw new GeminiError(`Gemini devolvió un error (${res.status}): ${detail || 'sin detalles'}`);
      }
      failures.push(`${model}: ${res.status}`);
    }

    // A remembered model that stopped working: re-discover the others.
    if (preferredModel && candidates.length === 1) {
      const discovered = await listCandidateModels(apiKey);
      candidates = candidates.concat(discovered.filter((id) => id !== preferredModel));
    }
  }

  throw new GeminiError(`Ningún modelo de Gemini respondió con esta clave (${failures.join('; ') || 'ninguno disponible'}).`);
}

function parseModelJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Fall back gracefully: treat the whole thing as plain reply text so a
    // malformed JSON turn doesn't crash the conversation.
    return { reply: text.trim(), translation: '', hasCorrection: false, correction: null };
  }

  const reply = typeof parsed.reply === 'string' ? parsed.reply : '';
  const translation = typeof parsed.translation === 'string' ? parsed.translation : '';
  const hasCorrection = Boolean(parsed.hasCorrection) &&
    parsed.correction &&
    (parsed.correction.originalText || parsed.correction.correctedText);

  return {
    reply: reply || '(el modelo no devolvió texto)',
    translation,
    hasCorrection,
    correction: hasCorrection ? parsed.correction : null,
  };
}

window.Gemini = { sendTurn, GeminiError };
