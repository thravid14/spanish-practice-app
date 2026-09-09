// Thin wrapper around the Gemini API. Swappable later if the AI backend
// changes (see project memory: AI backend choice was left open on purpose).

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

class GeminiError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GeminiError';
    this.cause = cause;
  }
}

/**
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {{speaker: 'user'|'ai', text: string}[]} history - prior turns, oldest first
 * @param {string} userMessage - the new user turn to append
 * @returns {Promise<{reply: string, hasCorrection: boolean, correction: object|null}>}
 */
async function sendTurn(apiKey, systemPrompt, history, userMessage) {
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

  let res;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new GeminiError('No se pudo conectar con Gemini. Revisa tu conexión a internet.', err);
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

  return parseModelJson(candidateText);
}

function parseModelJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Fall back gracefully: treat the whole thing as plain reply text so a
    // malformed JSON turn doesn't crash the conversation.
    return { reply: text.trim(), hasCorrection: false, correction: null };
  }

  const reply = typeof parsed.reply === 'string' ? parsed.reply : '';
  const hasCorrection = Boolean(parsed.hasCorrection) &&
    parsed.correction &&
    (parsed.correction.originalText || parsed.correction.correctedText);

  return {
    reply: reply || '(el modelo no devolvió texto)',
    hasCorrection,
    correction: hasCorrection ? parsed.correction : null,
  };
}

window.Gemini = { sendTurn, GeminiError };
