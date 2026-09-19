// Thin wrapper around the Gemini API. Swappable later if the AI backend
// changes (see project memory: AI backend choice was left open on purpose).

const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

class GeminiError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GeminiError';
    this.cause = cause;
  }
}

async function postGenerate(model, apiKey, body) {
  try {
    return await fetch(`${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new GeminiError('No se pudo conectar con Gemini. Revisa tu conexión a internet.', err);
  }
}

// Asks Google which models this specific key can call, and returns the stable
// full-size Flash ones (e.g. "gemini-3.8-flash"), newest first. Model names
// change over time and some keys can't reach older ones, so we discover
// rather than hardcode.
async function listFlashModels(apiKey) {
  let res;
  try {
    res = await fetch(`${API_BASE}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`);
  } catch (err) {
    throw new GeminiError('No se pudo conectar con Gemini. Revisa tu conexión a internet.', err);
  }
  if (!res.ok) return [];

  const data = await res.json();
  const version = (id) => parseFloat(id.match(/^gemini-([\d.]+)-flash$/)[1]);
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((id) => /^gemini-[\d.]+-flash$/.test(id))
    .sort((a, b) => version(b) - version(a));
}

/**
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

  let model = preferredModel || DEFAULT_MODEL;
  let res = await postGenerate(model, apiKey, body);

  // 404 means this key can't see that model (retired, or hidden from newer
  // keys). Find one it can, and use the first that answers.
  if (res.status === 404) {
    const candidates = (await listFlashModels(apiKey)).filter((id) => id !== model);
    for (const candidate of candidates) {
      const attempt = await postGenerate(candidate, apiKey, body);
      if (attempt.status !== 404) {
        model = candidate;
        res = attempt;
        break;
      }
    }
    if (res.status === 404) {
      throw new GeminiError(
        candidates.length
          ? `Ningún modelo Flash respondió con esta clave (probados: ${candidates.join(', ')}).`
          : 'Esta clave no tiene acceso a ningún modelo Flash de Gemini. Revisa que la clave esté activa en aistudio.google.com.'
      );
    }
  }

  if (!res.ok) {
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || '';
    } catch (_) {
      // ignore parse failure, fall through with empty detail
    }
    if (res.status === 400 && /API key/i.test(detail)) {
      throw new GeminiError('La clave de API no es válida. Revísala en Ajustes.');
    }
    if (res.status === 429) {
      throw new GeminiError('Se alcanzó el límite de peticiones de Gemini por ahora. Espera un momento e inténtalo de nuevo.');
    }
    throw new GeminiError(`Gemini devolvió un error (${res.status}): ${detail || 'sin detalles'}`);
  }

  const data = await res.json();
  const candidateText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';

  if (!candidateText) {
    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) {
      throw new GeminiError(`Gemini bloqueó la respuesta (${blockReason}).`);
    }
    throw new GeminiError('Gemini no devolvió texto en la respuesta.');
  }

  return { ...parseModelJson(candidateText), model };
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
