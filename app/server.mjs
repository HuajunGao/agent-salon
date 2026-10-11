// agent-salon server: the HTTP API, the snapshots pushed to the browsers, and startup. No npm dependencies.
// The room itself is in room.mjs (scheduler, turns, publishing, moderator), flows.mjs (modes' turn order), jobs.mjs,
// arena.mjs and outsider.mjs; persistence in db.mjs / config.mjs / chats.mjs; runtime state in runtime.mjs.
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AGENTS, listModels, installed } from './agents.mjs';
import { MODES, applyNotes } from './modes.mjs';
import { EN } from './i18n.mjs';
import { validateMember } from './members.mjs';
import { speechOn, loadCatalog, ttsModels, synth, transcribe, defaultVoice, FALLBACK_TTS } from './speech.mjs';
import { q, q1, run, getSetting, setSetting } from './db.mjs';
import { ROOT, UPLOADS, PUBLIC, RUNAS, MIME, extOf, avatarOf, avatarV, readMemory } from './workspace.mjs';
import { S, NAMES, memberConfigs, memberOrder, aliasOf, atOf, defaultAlias, tx, setLastLang, getWebHost, setWebHost,
  saveSettings, saveMember, deleteMember, setAlias } from './config.mjs';
import { chatId, paused, setPaused, chatExists, newChat, maxChat, chatState, saveState, chatMode, rules, sess, turnsSinceUser,
  TALK, logDecision, nickOf, userPlays, chatMessages, fmt, archiveFile, archiveSoon, flushArchive, writeIndex } from './chats.mjs';
import { rt, raise, pace, queued, addMember, removeMember, ready, wrapRound, wrapped, pump } from './runtime.mjs';
import { endGame, newGame, resumeGame } from './flows.mjs';
import { tasks, taskLive, killJob, recoverJobs, cleanupTasks } from './jobs.mjs';
import { arena, probing, arenaURL, arenaJob, arenaTick, referees, startArena, stopArena } from './arena.mjs';
import { startOutsider } from './outsider.mjs';
import { jev, mod, opening, classifying, jevOn, novFresh, score, stances, memo, maybeCurate, editMemory, spoken, voiceOf,
  userSends, stopAll, switchTo, setChatMode, openNow, publishNow, forgetChat } from './room.mjs';
import { provide, data, send, connect, resync } from './sse.mjs';

const PORT = +process.env.PORT || 3517, HOST = process.env.HOST || '127.0.0.1'; // HOST=0.0.0.0 to serve the LAN
const PROFILE = process.env.PROFILE || '';
const PROFILES = (process.env.PROFILES || '').split(',').filter(Boolean).map(p => p.split('=').map(x => x.trim()));
let modelLists = {};  // read once from each CLI at startup
// Which CLIs are installed (the UI offers them for new members and shows how to install the missing ones).
const harnessList = () => Object.fromEntries(Object.entries(AGENTS).filter(([, x]) => !x.optional)
  .map(([h, x]) => [h, { label: x.label, installed: installed(h) }]));
let harnesses = harnessList();

// ---------- what the browsers get ----------
// All a shared page gets: the discussion's title and who is talking. No memory, settings or other discussions.
const viewState = c => ({ type: 'state', now: Date.now(), chatId: c, title: q1('SELECT title FROM chats WHERE id=?', c)?.title || '',
  members: memberOrder().map(n => ({ name: n, label: aliasOf(n), color: memberConfigs[n].color, avatar: avatarV(n), enabled: S.enabled[n],
    status: c === chatId ? rt[n].status : 'idle', started: rt[n].started })) });
function state() {
  const now = Date.now(), hideLive = userPlays(chatId), st = chatState(chatId);
  return {
    type: 'state', now, profile: PROFILE, chatId, paused, mod, wrapped: !!wrapRound && wrapped(), settings: S, harnesses, runAs: RUNAS?.name || '', readLeft: Math.max(0, pace.readUntil - now),
    holding: now - pace.typingAt < 15e3, speaking: now - pace.speakingAt < 20e3,
    speech: { on: speechOn(), models: ttsModels(), defaults: Object.fromEntries(NAMES.map(n => [n, defaultVoice(NAMES.indexOf(n))])) },
    chats: listChats(),
    sandboxed: !!RUNAS,
    opening: opening?.chat === chatId ? opening.until : null,
    discussionMode: { ...chatMode(chatId), pending: classifying.has(chatId),
      rules: (({ flow, stance, notes }) => ({ flow, stance: !!stance, notesTitle: notes.title }))(rules(chatId)) },
    notes: st.notes || [],
    debate: (({ debate: d }) => d && !d.skipped ? { pro: d.pro, con: d.con, judge: d.judge, done: d.done, motion: d.motion,
      phase: d.script[d.at]?.phase || null, step: Math.min(d.at + 1, d.script.length), steps: d.script.length } : null)(st),
    // the user hosts: the whole game state, catches included; the user plays: no ledger until it is over
    game: (({ game: g }) => g?.host && { host: g.host, players: g.players, round: g.round, phase: g.phase, waiting: g.waiting,
      ordered: Object.keys(g.orders), ledger: g.user && !g.over ? '' : g.ledger, over: g.over || null, user: !!g.user,
      turn: g.phase === 'talk' ? g.queue[0] : g.phase === 'orders' && g.waiting.includes('user') && !('user' in g.orders) ? 'user' : null })(st),
    stances: stances(),
    arena: arena && { id: arena.id, chat: arena.chat, goal: arena.goal, until: arena.until, phase: arena.phase, referee: arena.referee,
      url: arenaURL(arena), probing, members: Object.entries(arena.members).map(([a, m]) => ({ name: a, rate: m.rate ?? null,
        probes: m.probes || 0, working: tasks.has(m.job), out: !!m.out })) },
    referees: S.exec ? referees() : [],
    memory: { text: readMemory(), curating: memo.curating, at: memo.at, error: memo.error },
    // running jobs (any discussion) and this discussion's recent ones
    jobs: q(`SELECT id, chat_id, agent, cmd, status, code, kind, branch, started_at, ended_at FROM jobs WHERE status='running' OR chat_id=? ORDER BY id DESC LIMIT 8`, chatId)
      .map(j => (tasks.has(j.id) ? { ...j, live: taskLive(j.id).slice(-3000) } : j)),
    jev: { on: jevOn(), assessing: jev.assessing, judging: jev.judging, ms: jev.ms, down: S.scheduler === 'jev' && !jevOn() },
    queue: queued().map(r => ({ agent: r.agent, basedOn: r.basedOn })),
    members: memberOrder().map(n => ({
      name: n, label: aliasOf(n), at: atOf(n), nick: nickOf(n), alias: memberConfigs[n].label || '', defaultAlias: defaultAlias(n), color: memberConfigs[n].color, avatar: avatarV(n), ...rt[n], enabled: S.enabled[n], model: S.models[n],
      configurable: memberConfigs[n].harness === 'opencode', harness: memberConfigs[n].harness, installed: harnesses[memberConfigs[n].harness]?.installed ?? true, live: hideLive ? '' : rt[n].live,
      harnessLabel: AGENTS[memberConfigs[n].harness].label,
      config: { baseURL: memberConfigs[n].baseURL || '',
        protocol: memberConfigs[n].protocol || 'responses', persona: memberConfigs[n].persona || '', hasKey: !!memberConfigs[n].apiKey },
      sid: sess(chatId, n).cli_session_id, turns: q1('SELECT count(*) n FROM messages WHERE chat_id=? AND sender=?', chatId, n).n,
      sinceUser: turnsSinceUser(n), score: rt[n].hand && rt[n].status === 'idle' ? +score(n).s.toFixed(2) : null,
      nov: novFresh(n) ? rt[n].nov.p : null,
    })),
  };
}
// History list: newest activity first, with size, the latest question as a preview, and the discussion's mode
// (kind: the chosen mode, else what Auto classified, else the mode its replies were written in; null when none).
const listChats = () => q(`SELECT c.id, c.title, c.created_at, c.mode, c.auto_mode,
    (SELECT mode FROM messages WHERE chat_id=c.id AND mode IS NOT NULL ORDER BY id DESC LIMIT 1) used,
    (SELECT count(*) FROM messages WHERE chat_id=c.id AND ${TALK}) n,
    (SELECT max(created_at) FROM messages WHERE chat_id=c.id) last,
    (SELECT text FROM messages WHERE chat_id=c.id AND kind='user' ORDER BY id DESC LIMIT 1) preview
  FROM chats c ORDER BY coalesce(last, c.created_at) DESC, c.id DESC`)
  .map(({ mode, auto_mode, used, ...c }) => ({ ...c, preview: c.preview?.slice(0, 60) || '',
    kind: [mode, auto_mode, used].find(k => MODES[k]) || null })); // used: the mode its replies were written in
const prompts = () => JSON.parse(getSetting('prompts') || '[]');
const savePrompts = list => { setSetting('prompts', JSON.stringify(list)); logDecision('prompts', null, { detail: { n: list.length } }); resync(); };
const init = () => ({ type: 'init', messages: chatMessages(chatId), state: state(), modelLists, prompts: prompts() });
provide({ init, state, view: viewState });

// ---------- HTTP: JSON actions ----------
// Each handler checks its input and calls the room; the scheduler looks again after every action (pump).
const routes = {
  'POST /api/member/order'({ names }) {
    if (!Array.isArray(names) || names.length !== NAMES.length || new Set(names).size !== NAMES.length || names.some(n => !NAMES.includes(n)))
      throw new Error('成员列表已变化，请刷新后重新排序');
    S.memberOrder = names;
    saveSettings(); logDecision('member-order', null, { detail: { names } });
    resync();
  },
  async 'POST /api/models/refresh'() {
    modelLists = await listModels(); harnesses = harnessList();
    resync();
    return { modelLists };
  },
  'POST /api/member/alias'({ name, label }) {
    if (!NAMES.includes(name)) throw new Error('成员不存在');
    setAlias(name, String(label || '').trim().slice(0, 60));
    logDecision('member-alias', name); resync();
  },
  // Configuration and removal wait until the member's turn is published and the moderator isn't judging.
  'POST /api/member/save'(body) {
    if (jev.assessing || jev.judging) throw new Error('主持人正在评估，请稍后再保存成员');
    const name = String(body.name || '').toLowerCase();
    if (memberConfigs[name] && memberConfigs[name].harness !== 'opencode') throw new Error('该标识已由其他运行工具的成员使用');
    if (rt[name]?.status === 'thinking' || ready.some(r => r.agent === name)) throw new Error('请等该成员完成本轮并发布后再修改配置');
    const m = validateMember(body, memberConfigs[name]);
    if (!memberConfigs[name] && harnesses[m.harness] && !harnesses[m.harness].installed) throw new Error(tx('没有找到 {cli} 的 CLI，请先安装', { cli: AGENTS[m.harness].label }));
    if (saveMember(name, m)) addMember(name);
    Object.assign(rt[name], { hand: null, error: '', live: '' });
    logDecision('member-config', name, { detail: { model: m.model } });
    resync();
  },
  'POST /api/member/delete'({ name }) {
    if (jev.assessing || jev.judging) throw new Error('主持人正在评估，请稍后再移除成员');
    if (!NAMES.includes(name)) throw new Error('成员不存在');
    if (rt[name].status === 'thinking' || ready.some(r => r.agent === name)) throw new Error('请等该成员完成本轮并发布后再移除');
    deleteMember(name); removeMember(name);
    logDecision('member-delete', name); resync();
  },
  'POST /api/send'({ text, reply_to, chat_id, files }) {
    text = String(text || '').trim();
    // The current discussion is shared by all windows: refuse a message typed while looking at another one.
    if (chat_id && +chat_id !== chatId) throw new Error('当前讨论已在别的窗口切换，消息未发送，请确认后重发。');
    // attachments: this discussion's uploads only, as /api/upload returned them
    files = (Array.isArray(files) ? files : []).filter(f => typeof f?.file === 'string' && f.file.startsWith(`${chatId}/`)
      && !/\.\.|\\/.test(f.file) && existsSync(join(UPLOADS, f.file)))
      .map(f => ({ file: f.file, name: String(f.name || '').slice(0, 120), size: +f.size || 0, type: String(f.type || '').slice(0, 80) }));
    if (!text && !files.length) return;
    userSends(text, reply_to, files);
  },
  'POST /api/typing'({ typing }) { pace.typingAt = typing ? Date.now() : 0; },
  'POST /api/speaking'({ speaking }) { pace.speakingAt = speaking ? Date.now() : 0; pace.ttsActiveAt = Date.now(); },
  'POST /api/next'() { publishNow(); },
  'POST /api/pause'({ paused: p }) { setPaused(p); },
  'POST /api/job/stop'({ id }) { killJob(+id, 'stopped'); },
  'POST /api/stop'() { stopAll(); },
  'POST /api/opening/go'() { openNow(chatId); },
  'POST /api/game/end'() { endGame(); },
  'POST /api/game/new'() { newGame(); },
  'POST /api/arena/start'(body) { startArena(chatId, body); },
  'POST /api/arena/stop'() { stopArena(); },
  'POST /api/outsider'() { if (!startOutsider(chatId, 'user')) throw new Error('局外人已经在想了，或者没有可用的成员'); },
  'POST /api/floor'({ agent }) { if (NAMES.includes(agent)) { raise(agent, 100, 'floor from user'); logDecision('floor', agent); } },
  'POST /api/lower'({ agent }) { if (NAMES.includes(agent)) rt[agent].hand = null; },
  'POST /api/settings'(body) {
    for (const k of ['language', 'scheduler']) if (typeof body[k] === 'string' && body[k]) S[k] = body[k];
    if (['', 'zh', 'en'].includes(body.uiLang)) S.uiLang = body.uiLang;
    if (typeof body.userName === 'string') S.userName = body.userName.trim().slice(0, 20); // '' = 用户
    for (const k of ['autoStop', 'devil', 'circlePause', 'memory', 'exec', 'blind', 'outsider', 'userPlays']) if (typeof body[k] === 'boolean') S[k] = body[k];
    for (const k of ['turnCap', 'readSpeed', 'maxThinkers', 'convergeAt', 'noveltyMin']) if (+body[k] > 0) S[k] = +body[k];
    if (body.enabled) S.enabled = { ...S.enabled, ...body.enabled };
    // Read-aloud voice per member: a TTS model id from the gateway catalog, '' = default.
    for (const [a, v] of Object.entries(body.ttsVoices || {}))
      if (NAMES.includes(a) && (v === '' || ttsModels().some(t => t.id === v))) {
        S.ttsVoices = { ...S.ttsVoices }; if (v) S.ttsVoices[a] = v; else delete S.ttsVoices[a];
      }
    // Only models a CLI listed (or its default) are accepted; the next turn uses it and resumes the same session.
    for (const [a, m] of Object.entries(body.models || {}))
      if (NAMES.includes(a) && typeof m === 'string' && (m === '' || (m.length <= 200 && /^\S+$/.test(m)))) {
        S.models[a] = m; logDecision('model', a, { detail: { model: m } });
      }
    saveSettings();
  },
  'POST /api/chat/new'({ title }) {
    switchTo(newChat(title || tx('讨论 {n}', { n: maxChat() + 1 })));
    return { id: chatId };
  },
  // Saved prompts (the user's favourite openings, e.g. a game's full rules), with the mode to start them in.
  // Same title: replaced. Sent to the browsers with init, not with every state tick.
  'POST /api/prompts/save'({ title, text, mode }) {
    title = String(title || '').trim().slice(0, 60); text = String(text || '').trim().slice(0, 50000);
    if (!title || !text) throw new Error('标题和内容都不能为空');
    const list = prompts().filter(p => p.title !== title);
    list.unshift({ id: randomBytes(4).toString('hex'), title, text, mode: MODES[mode] ? mode : null, at: Date.now() });
    savePrompts(list);
  },
  'POST /api/prompts/delete'({ id }) { savePrompts(prompts().filter(p => p.id !== id)); },
  'POST /api/chat/switch'({ id }) { if (chatExists(+id)) switchTo(+id); },
  'POST /api/chat/mode'({ id, mode }) {
    id = +id;
    if (chatExists(id) && (mode === 'auto' || MODES[mode])) setChatMode(id, mode);
  },
  // The discussion's read-only link code (made once, kept): /s/<code>.
  'POST /api/chat/share'({ id }) {
    const c = q1('SELECT share FROM chats WHERE id=?', +id);
    if (!c) throw new Error('讨论不存在');
    const share = c.share || randomBytes(6).toString('base64url');
    if (!c.share) { run('UPDATE chats SET share=? WHERE id=?', share, +id); logDecision('share', null, { detail: { chat: +id } }); }
    return { share };
  },
  'POST /api/chat/rename'({ id, title }) {
    title = String(title || '').trim().slice(0, 80);
    if (title) run('UPDATE chats SET title=? WHERE id=?', title, +id);
  },
  // The user can correct the memory directly; "curate" folds in new messages now.
  'POST /api/memory'({ text }) { editMemory(text); },
  'POST /api/memory/curate'() { maybeCurate(true); },
  // The user edits the discussion's notes directly: {op: add | edit | drop, n, text}.
  'POST /api/notes'({ chat_id, op, n, text }) {
    const c = +chat_id;
    if (!chatExists(c) || !['add', 'edit', 'drop'].includes(op)) return;
    const st = chatState(c);
    const changed = applyNotes(st.notes ??= [], [{ op, n: +n, text: String(text || '').trim().slice(0, 300) }].filter(o => o.op === 'drop' || o.text), { by: 'user' });
    saveState(c, st); logDecision('notes', null, { detail: { op, n: +n, changed } });
  },
  // Deletes the discussion with its messages, agent session records and decision log (CLI sessions stay in each CLI).
  'POST /api/chat/delete'({ id }) {
    id = +id;
    if (!chatExists(id)) return;
    for (const t of ['messages', 'agent_sessions', 'decisions']) run(`DELETE FROM ${t} WHERE chat_id=?`, id);
    run('DELETE FROM chats WHERE id=?', id);
    rmSync(archiveFile(id), { force: true }); writeIndex();
    rmSync(join(UPLOADS, String(id)), { recursive: true, force: true });
    forgetChat(id);
    if (id === chatId) switchTo(q1('SELECT max(id) m FROM chats').m || newChat(tx('讨论 {n}', { n: 1 })));
  },
};
// GET routes return data instead of acting.
const getRoutes = {
  // Full-text search over titles and messages: [{chat_id, title, id, sender, snippet}]
  '/api/search'(p) {
    const s = String(p.get('q') || '').trim();
    if (!s) return [];
    const like = `%${s.replace(/[%_\\]/g, '\\$&')}%`;
    return q(`SELECT m.chat_id, c.title, m.id, m.sender, m.text FROM messages m JOIN chats c ON c.id=m.chat_id
      WHERE (m.text LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\') AND m.kind IN ('user','agent') ORDER BY m.id DESC LIMIT 50`, like, like)
      .map(m => { const i = Math.max(0, m.text.toLowerCase().indexOf(s.toLowerCase()) - 20);
        return { chat_id: m.chat_id, title: m.title, id: m.id, sender: m.sender, snippet: m.text.slice(i, i + 80) }; });
  },
};

// ---------- HTTP: pages, files, streams ----------
const page = name => readFileSync(join(ROOT, 'app', name));
const notFound = res => { res.writeHead(404); res.end(); };
// A raw request body, refused past max bytes.
const readBody = (req, max, done) => {
  const chunks = []; let size = 0;
  req.on('data', d => { size += d.length; if (size > max) req.destroy(); else chunks.push(d); });
  req.on('end', () => done(Buffer.concat(chunks)));
};
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  if (key === 'GET /' && req.headers.host && req.headers.host !== getWebHost() && /^[\w.:\[\]-]+$/.test(req.headers.host)) setWebHost(req.headers.host);
  if (key === 'GET /' || /^GET \/s\/[\w-]+$/.test(key)) { // /s/<code>: the same page, showing one discussion read-only
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(String(page('index.html')).replace('<html lang="zh">', `<html lang="${S.uiLang}">`));
  }
  if (key === 'GET /ui.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(page('ui.js'));
  }
  if (key === 'GET /i18n.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(`const EN = ${JSON.stringify(EN)};`);
  }
  if (key === 'GET /who') { // the entry page: pick whose chat to open (no login, LAN only)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-salon</title><style>body{font:16px system-ui,sans-serif;display:grid;place-content:center;gap:16px;min-height:90vh;margin:0}
a{display:block;padding:18px 48px;border:1px solid #ccc;border-radius:12px;text-align:center;font-size:20px;color:inherit;text-decoration:none}
a:hover{background:#f3f3f3}</style><h2 style="text-align:center;font-weight:500">${tx('你是谁？')}</h2>
<script>for (const [name, at] of ${JSON.stringify(PROFILES.length ? PROFILES : [[PROFILE || 'agent-salon', '']]).replace(/</g, '\\u003c')}) {
  const a = document.createElement('a'); a.textContent = name;
  a.href = at.startsWith(':') ? location.protocol + '//' + location.hostname + at + '/' : at || '/';
  document.body.append(a);
}</script>`);
  }
  if (key === 'GET /vendor/marked.umd.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=86400' });
    return res.end(page('vendor/marked.umd.js'));
  }
  const url = new URL(req.url, 'http://x');
  if (key === 'GET /events') {
    // x-accel-buffering: behind nginx (the home reverse proxy) events must not wait in its buffer.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const code = url.searchParams.get('s');
    const view = code ? q1('SELECT id FROM chats WHERE share=?', code)?.id ?? -1 : null; // -1: no such link
    const lang = url.searchParams.get('lang');
    if (view == null && (lang === 'zh' || lang === 'en')) setLastLang(lang);
    return connect(res, view, view == null ? init() : { type: 'init', state: view < 0 ? { ...viewState(view), title: tx('这个分享链接已失效') } : viewState(view),
      messages: chatMessages(view) });
  }
  if (req.method === 'GET' && getRoutes[url.pathname]) return json(res, 200, getRoutes[url.pathname](url.searchParams));
  // Read-aloud audio for one agent message (proxied from the LAN speech gateway). Falls back to OmniVoice if the
  // member's voice fails.
  if (key === 'GET /api/tts') {
    const m = q1(`SELECT sender, text FROM messages WHERE id=? AND kind='agent'`, +url.searchParams.get('id'));
    if (!speechOn() || !m || !memberConfigs[m.sender]) return notFound(res);
    pace.ttsActiveAt = Date.now();
    const text = spoken(m.sender, m.text);
    synth(text, voiceOf(m.sender)).catch(() => synth(text, FALLBACK_TTS))
      .then(a => { res.writeHead(200, { 'content-type': a.type, 'cache-control': 'no-store' }); res.end(a.buf); })
      .catch(e => json(res, 502, { error: e.message }));
    return;
  }
  // Voice input: the browser posts 16 kHz mono WAV; the gateway's Azure STT returns the text.
  if (key === 'POST /api/stt') {
    if (!speechOn()) return notFound(res);
    return readBody(req, 10e6, buf => transcribe(buf).then(text => json(res, 200, { text })).catch(e => json(res, 502, { error: e.message })));
  }
  // An attachment for the current discussion (raw body, ?name=): returns {file, name, size, type} for /api/send.
  if (key === 'POST /api/upload') {
    const name = (url.searchParams.get('name') || 'file').slice(0, 120), chat = chatId;
    return readBody(req, 20e6, buf => {
      const dir = join(UPLOADS, String(chat)), stored = `${Date.now().toString(36)}-${name.replace(/[^\p{L}\p{N}._-]+/gu, '_')}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, stored), buf);
      json(res, 200, { file: `${chat}/${stored}`, name, size: buf.length, type: String(req.headers['content-type'] || '') });
    });
  }
  // Attachments are served back with a sandbox policy (an uploaded HTML or SVG can't run in the app's origin);
  // only images, PDFs and plain text open in the browser, anything else downloads.
  // /w/...: the members' shared public/ folder. Their pages run sandboxed (an opaque origin, so not as the app);
  // CORS lets such a page fetch its own data files.
  if (req.method === 'GET' && url.pathname.startsWith('/w/')) {
    let p = resolve(PUBLIC, '.' + decodeURIComponent(url.pathname.slice(2)));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!p.startsWith(PUBLIC + sep) || !existsSync(p)) return notFound(res);
    const type = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
      svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', txt: 'text/plain', md: 'text/plain' }[p.split('.').pop().toLowerCase()];
    res.writeHead(200, { 'content-type': type ? `${type}; charset=utf-8` : 'application/octet-stream', 'cache-control': 'no-store',
      'content-security-policy': 'sandbox allow-scripts', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' });
    return res.end(readFileSync(p));
  }
  const am = req.method === 'GET' && url.pathname.match(/^\/avatar\/([^/]+)$/);
  if (am) {
    const a = decodeURIComponent(am[1]), p = memberConfigs[a] && avatarOf(a);
    if (!p) return notFound(res);
    res.writeHead(200, { 'content-type': MIME[extOf(p)], 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff', 'cache-control': 'max-age=86400' });
    return res.end(readFileSync(p));
  }
  const fm = req.method === 'GET' && url.pathname.match(/^\/files\/(\d+)\/([^/]+)$/);
  if (fm) {
    const name = decodeURIComponent(fm[2]), p = join(UPLOADS, fm[1], name);
    if (/\.\.|[\\/]/.test(name) || !existsSync(p)) return notFound(res);
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
      txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8' }[name.split('.').pop().toLowerCase()];
    res.writeHead(200, { 'content-type': type || 'application/octet-stream', 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff',
      'content-disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name.replace(/^[a-z0-9]+-/, ''))}`, 'cache-control': 'max-age=86400' });
    return res.end(readFileSync(p));
  }
  if (key === 'GET /api/export') { // markdown download of one discussion
    const c = q1('SELECT * FROM chats WHERE id=?', +url.searchParams.get('id'));
    if (!c) return notFound(res);
    const body = `# ${c.title}\n\n` + q('SELECT * FROM messages WHERE chat_id=? ORDER BY id', c.id)
      .map(m => m.kind === 'moderator' ? `> ${m.text}` : `**${fmt(m).replace(/^(#\d+ \S+)/, '$1**')}`).join('\n\n') + '\n';
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(c.title)}.md` });
    return res.end(body);
  }
  const h = routes[key];
  if (!h) return notFound(res);
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', async () => {
    try { const result = await h(body ? JSON.parse(body) : {}); pump(); res.writeHead(200).end(JSON.stringify(result || {})); }
    catch (e) { console.error(e); res.writeHead(500).end(JSON.stringify({ error: tx(e.message) })); }
  });
}).listen(PORT, HOST, () => console.log(`agent-salon on http://${HOST}:${PORT}`));

// ---------- startup ----------
// What was running when the server stopped: jobs and tasks are reported as interrupted (a training window resumes its
// own sessions), a game whose turns were due carries on, the archive is rewritten.
recoverJobs(j => arenaJob(j.id));
resumeGame(chatId);
for (const c of q('SELECT id FROM chats')) archiveSoon(c.id); // archive discussions from before the archive existed
flushArchive();
listModels().then(l => { modelLists = l; resync(); });
loadCatalog().then(() => resync()); // the gateway's voices, for the per-member voice picker
setInterval(() => { harnesses = harnessList(); }, 60e3).unref(); // a CLI installed while running shows up within a minute
setInterval(pump, 1000); // thinking timers, reading countdown, typing hold expiry
setInterval(arenaTick, 1000);
setInterval(cleanupTasks, 86400e3);
