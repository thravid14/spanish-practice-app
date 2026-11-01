// Browser-native speech: SpeechRecognition (mic -> text) and SpeechSynthesis
// (text -> spoken Spanish). Both are free and need no API key. Validated on
// Android Chrome with tools/voz-check.html.

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

const RATES = { slow: 0.8, normal: 1.0 };

const supportsRecognition = Boolean(SpeechRecognitionCtor);
const supportsSynthesis = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

let recognition = null;

/**
 * Starts listening. Callbacks:
 *   onInterim(text)  - partial transcript while the user is still talking
 *   onFinal(text)    - the finished transcript (called at most once)
 *   onError(code)    - a SpeechRecognition error code, e.g. 'not-allowed'
 *   onEnd(heardText) - always called last; heardText is '' if nothing was heard
 */
function startListening(lang, { onInterim, onFinal, onError, onEnd }) {
  if (!supportsRecognition) return false;
  stopListening();

  const rec = new SpeechRecognitionCtor();
  rec.lang = lang;
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let heard = '';
  let finalised = false;

  rec.onresult = (event) => {
    let text = '';
    let isFinal = false;
    for (let i = 0; i < event.results.length; i++) {
      text += event.results[i][0].transcript;
      if (event.results[i].isFinal) isFinal = true;
    }
    heard = text.trim();
    if (isFinal && !finalised) {
      finalised = true;
      onFinal(heard);
    } else if (!isFinal) {
      onInterim(heard);
    }
  };
  rec.onerror = (event) => onError(event.error);
  rec.onend = () => {
    if (recognition === rec) recognition = null;
    onEnd(finalised ? heard : '');
  };

  recognition = rec;
  try {
    rec.start();
  } catch (err) {
    recognition = null;
    onError('start-failed');
    onEnd('');
  }
  return true;
}

function stopListening() {
  if (recognition) {
    try { recognition.stop(); } catch (_) { /* already stopped */ }
  }
}

function isListening() {
  return recognition !== null;
}

// Picks the best installed voice for a dialect: exact match (es-MX) first,
// then any Spanish voice. Android reports some langs with underscores.
function pickVoice(lang) {
  const norm = (l) => (l || '').replace('_', '-').toLowerCase();
  const voices = speechSynthesis.getVoices().filter((v) => norm(v.lang).startsWith('es'));
  return voices.find((v) => norm(v.lang) === norm(lang)) || voices[0] || null;
}

function speak(text, lang, speed) {
  if (!supportsSynthesis || !text) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.rate = RATES[speed] || RATES.slow;
  const voice = pickVoice(lang);
  if (voice) utter.voice = voice;
  speechSynthesis.speak(utter);
}

function cancelSpeech() {
  if (supportsSynthesis) speechSynthesis.cancel();
}

// Voices load asynchronously in Chrome; touching the list early warms it up.
if (supportsSynthesis) speechSynthesis.getVoices();

window.Voice = {
  supportsRecognition,
  supportsSynthesis,
  startListening,
  stopListening,
  isListening,
  speak,
  cancelSpeech,
};
