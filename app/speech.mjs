// Text-to-speech and speech-to-text through the home LAN's OpenAI-compatible Speech Gateway (never public OpenAI).
// SPEECH_BASE_URL=http://<gateway>:8090/v1 enables it; SPEECH_API_KEY is any non-empty string (gateway convention:
// home-speech). The server proxies all calls, so the browser never talks to the gateway directly.
const BASE = (process.env.SPEECH_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SPEECH_API_KEY || 'home-speech';
// Azure (free, many voices) gives each member its own voice; the gateway accepts any "azure:<voice>". Alternating
// female/male, the two multilingual voices first (they handle mixed Chinese/English best). All verified on the gateway.
export const VOICE_POOL = [
  ['azure:zh-CN-XiaoxiaoMultilingualNeural', 'Azure 晓晓（女，多语言）'], ['azure:zh-CN-YunyiMultilingualNeural', 'Azure 云逸（男，多语言）'],
  ['azure:zh-CN-XiaochenNeural', 'Azure 晓辰（女）'], ['azure:zh-CN-YunxiNeural', 'Azure 云希（男）'],
  ['azure:zh-CN-XiaoyiNeural', 'Azure 晓伊（女）'], ['azure:zh-CN-YunjianNeural', 'Azure 云健（男）'],
  ['azure:zh-CN-XiaohanNeural', 'Azure 晓涵（女）'], ['azure:zh-CN-YunyangNeural', 'Azure 云扬（男）'],
  ['azure:zh-CN-XiaomoNeural', 'Azure 晓墨（女）'], ['azure:zh-CN-YunfengNeural', 'Azure 云枫（男）'],
  ['azure:zh-CN-XiaoxuanNeural', 'Azure 晓萱（女）'], ['azure:zh-CN-YunxiaNeural', 'Azure 云夏（男，童声）'],
].map(([id, label]) => ({ id, label }));
export const defaultVoice = index => VOICE_POOL[index % VOICE_POOL.length].id;
export const FALLBACK_TTS = 'omnivoice'; // if Azure fails; OmniVoice keeps mixed text best but has one voice and needs the GPU
export const speechOn = () => !!BASE;

// Voices offered per member: the Azure pool plus whatever else the gateway's catalog lists (e.g. OmniVoice).
let catalog = [];
export async function loadCatalog() {
  if (!BASE) return [];
  let extra = [];
  try {
    const r = await fetch(BASE.replace(/\/v1$/, '') + '/v1/test/catalog', { signal: AbortSignal.timeout(10e3) });
    // MiniMax is left out for now (its plan expired: "insufficient balance"); bare "azure" is just its default voice.
    extra = (await r.json()).tts.filter(t => !['tts-1', 'azure'].includes(t.id) && t.backend !== 'minimax')
      .map(t => ({ id: t.id, label: t.label }));
  } catch { extra = [{ id: FALLBACK_TTS, label: 'OmniVoice' }]; }
  catalog = [...VOICE_POOL, ...extra.filter(t => !VOICE_POOL.some(v => v.id === t.id))];
  return catalog;
}
export const ttsModels = () => catalog;

// What a listener should hear: no markdown, code or URLs. Message numbers mean nothing by ear: a parenthesis of only
// references is dropped, and any other #N becomes its author's name (nameOf(id) → name, or null to drop it).
const REF_LIST = /\s*[(（]\s*#\d+(?:\s*(?:[,，、和与]|and)\s*#\d+)*\s*[)）]/g;
export function speakable(text, nameOf = () => null) {
  return text
    .replace(REF_LIST, '')
    .replace(/#(\d+)/g, (_, id) => nameOf(+id) || '')
    .replace(/```[\s\S]*?```/g, '（代码略）')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '（链接）')
    .replace(/(\*\*|__|~~)/g, '').replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/@(\w+)/g, '$1')
    .replace(/\s+/g, ' ').trim().slice(0, 1500);
}

// Small cache so a reply synthesized while it waited in the publish queue plays without delay.
const cache = new Map(), inflight = new Map();
export function synth(text, model) {
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
