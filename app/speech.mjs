// Text-to-speech and speech-to-text through the home LAN's OpenAI-compatible Speech Gateway (never public OpenAI).
// SPEECH_BASE_URL=http://<gateway>:8090/v1 enables it; SPEECH_API_KEY is any non-empty string (gateway convention:
// home-speech). The server proxies all calls, so the browser never talks to the gateway directly.
const BASE = (process.env.SPEECH_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SPEECH_API_KEY || 'home-speech';
export const DEFAULT_TTS = 'omnivoice'; // best for mixed Chinese/English; Azure may drop words in mixed text
export const speechOn = () => !!BASE;

// TTS model ids the gateway offers (each Azure id is a distinct voice; OmniVoice ignores `voice`).
let catalog = [];
export async function loadCatalog() {
  if (!BASE) return [];
  try {
    const r = await fetch(BASE.replace(/\/v1$/, '') + '/v1/test/catalog', { signal: AbortSignal.timeout(10e3) });
    // MiniMax is left out for now (its plan expired: "insufficient balance").
    catalog = (await r.json()).tts.filter(t => t.id !== 'tts-1' && t.backend !== 'minimax').map(t => ({ id: t.id, label: t.label }));
  } catch { catalog = [{ id: DEFAULT_TTS, label: 'OmniVoice' }]; }
  return catalog;
}
export const ttsModels = () => catalog;

// What a listener should hear: no markdown, code or URLs; message refs and handles read naturally.
export function speakable(text) {
  return text
    .replace(/```[\s\S]*?```/g, '（代码略）')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '（链接）')
    .replace(/(\*\*|__|~~)/g, '').replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/#(\d+)/g, '$1号').replace(/@(\w+)/g, '$1')
    .replace(/\s+/g, ' ').trim().slice(0, 1500);
}

// Small cache so a reply synthesized while it waited in the publish queue plays without delay.
const cache = new Map(), inflight = new Map();
export function synth(text, model = DEFAULT_TTS) {
  const key = model + '\n' + text;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const r = await fetch(BASE + '/audio/speech', { method: 'POST', signal: AbortSignal.timeout(90e3),
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: text, voice: 'alloy', response_format: 'wav' }) });
    if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const audio = { type: r.headers.get('content-type') || 'audio/wav', buf: Buffer.from(await r.arrayBuffer()) };
    cache.set(key, audio);
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    return audio;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// wav: 16 kHz mono PCM WAV (the browser converts; Azure STT rejects webm/ogg). Returns the text.
export async function transcribe(wav, model = 'azure') {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  const r = await fetch(BASE + '/audio/transcriptions', { method: 'POST', body: form, signal: AbortSignal.timeout(60e3),
    headers: { authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`stt ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).text || '';
}
