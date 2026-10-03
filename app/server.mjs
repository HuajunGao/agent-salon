// agent-chat server: SQLite + SSE + scheduler + reading-pace publish queue. No npm dependencies.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AGENTS, runTurn } from './agents.mjs';
import { judge } from './moderator.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'data'), WORK = join(ROOT, 'workspace'), TRANSCRIPT = join(DATA, 'transcript.md');
mkdirSync(DATA, { recursive: true }); mkdirSync(WORK, { recursive: true });
const PORT = +process.env.PORT || 3517;
const NAMES = Object.keys(AGENTS);

// ---------- storage ----------
const db = new DatabaseSync(join(DATA, 'chat.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS chats(id INTEGER PRIMARY KEY, title TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, paused INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, chat_id INTEGER, sender TEXT, kind TEXT, text TEXT,
  based_on INTEGER, reply_to INTEGER, latency_ms INTEGER, turn_no INTEGER, stale INTEGER DEFAULT 0,
  collapsed INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS agent_sessions(chat_id INTEGER, agent TEXT, cli_session_id TEXT, last_seen_id INTEGER DEFAULT 0,
  turns INTEGER DEFAULT 0, status TEXT, updated_at TEXT, PRIMARY KEY(chat_id, agent));
-- Every scheduler decision, for comparing scheduler modes later.
CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY, chat_id INTEGER, at TEXT DEFAULT CURRENT_TIMESTAMP, mode TEXT,
  event TEXT, agent TEXT, score REAL, detail TEXT, based_on INTEGER, message_id INTEGER, latency_ms INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`);
const q = (sql, ...a) => db.prepare(sql).all(...a);
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

const DEFAULTS = { language: '中文', turnCap: 3, readSpeed: 400, maxThinkers: 2, scheduler: 'algorithm', autoStop: true, convergeAt: 80,
  enabled: Object.fromEntries(NAMES.map(n => [n, true])) };
let S = { ...DEFAULTS, ...JSON.parse(q1(`SELECT value FROM settings WHERE key='s'`)?.value || '{}') };
const saveSettings = () => run(`INSERT OR REPLACE INTO settings VALUES('s', ?)`, JSON.stringify(S));

let chatId = q1('SELECT max(id) id FROM chats')?.id || Number(run(`INSERT INTO chats(title) VALUES('讨论 1')`).lastInsertRowid);
let paused = !!q1('SELECT paused FROM chats WHERE id=?', chatId).paused;

const sess = (c, a) => q1('SELECT * FROM agent_sessions WHERE chat_id=? AND agent=?', c, a)
  || (run('INSERT INTO agent_sessions(chat_id, agent) VALUES(?,?)', c, a), sess(c, a));
const maxId = c => q1('SELECT coalesce(max(id),0) m FROM messages WHERE chat_id=?', c).m;
const lastUserId = c => q1(`SELECT coalesce(max(id),0) m FROM messages WHERE chat_id=? AND kind='user'`, c).m;

function logDecision(event, agent, extra = {}) {
  run('INSERT INTO decisions(chat_id, mode, event, agent, score, detail, based_on, message_id, latency_ms) VALUES(?,?,?,?,?,?,?,?,?)',
    chatId, S.scheduler, event, agent ?? null, extra.score ?? null, extra.detail ? JSON.stringify(extra.detail) : null,
    extra.based_on ?? null, extra.message_id ?? null, extra.latency_ms ?? null);
}

function insertMsg(m) {
  const id = Number(run(`INSERT INTO messages(chat_id, sender, kind, text, based_on, reply_to, latency_ms, turn_no, stale)
    VALUES(?,?,?,?,?,?,?,?,?)`, m.chat_id, m.sender, m.kind, m.text, m.based_on ?? null, m.reply_to ?? null,
    m.latency_ms ?? null, m.turn_no ?? null, m.stale ? 1 : 0).lastInsertRowid);
  const msg = q1('SELECT * FROM messages WHERE id=?', id);
  writeTranscript(m.chat_id);
  if (m.chat_id === chatId) send({ type: 'msg', msg });
  return msg;
}

const who = s => (s === 'user' ? '用户 (user)' : AGENTS[s] ? `${AGENTS[s].label} (${s})` : s);
const fmt = m => `#${m.id} ${who(m.sender)}${m.reply_to ? ` (回复 #${m.reply_to})` : ''}: ${m.text}`;
function writeTranscript(c) {
  const t = q1('SELECT title FROM chats WHERE id=?', c).title;
  writeFileSync(TRANSCRIPT, `# ${t}\n\n` + q('SELECT * FROM messages WHERE chat_id=? ORDER BY id', c).map(fmt).join('\n\n') + '\n');
}

// ---------- runtime state ----------
// hand: {r: relevance, since, why}; r >= 100 means the user gave the floor (bypasses cap and "nothing new").
const rt = Object.fromEntries(NAMES.map(n => [n, { status: 'idle', started: 0, live: '', hand: null, note: '', error: '' }]));
let ready = [];          // finished replies waiting to be published: {chat, agent, text, basedOn, ms, hand, turnNo}
let readUntil = 0, typingAt = 0;
let mod = null;                         // latest Jev judgment this round: {convergence, stalling, msgId}
let wrapRound = 0;                      // round (= last user message id) already wrapped up

const MENTION = { claude: 'claude', codex: 'codex', agy: 'agy', gemini: 'agy', opencode: 'opencode', glm: 'opencode' };
const mentions = text => [...new Set([...text.matchAll(/@(\w+)/g)].map(m => MENTION[m[1].toLowerCase()]).filter(Boolean))];

function raise(a, r, why) {
  if (!S.enabled[a]) return;
  const h = rt[a].hand;
  rt[a].hand = { r: Math.max(r, h?.r || 0), since: h?.since || Date.now(), why: h && h.r > r ? h.why : why };
}

// ---------- scheduler ----------
// Fairness modifies priority, it doesn't decide it: score = relevance × fairness × freshness − cooldown.
// Relevance comes from explicit signals now; the Jev scheduler (Phase 2) will supply it as a judgment.
function score(a) {
  const h = rt[a].hand;
  const msgs = q('SELECT id, sender FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 50', chatId);
  const silence = msgs.findIndex(m => m.sender === a);               // messages since a last spoke
  const fairness = 1 + 0.1 * Math.min(silence < 0 ? 10 : silence, 10); // capped: silence helps, but only so much
  const freshness = 1 / (1 + (Date.now() - h.since) / 300e3);         // hands decay over minutes
  const sinceUser = turnsSinceUser(a);
  const cooldown = (silence >= 0 && silence < 2 ? 0.4 : 0) + 0.2 * sinceUser;
  const s = h.r * fairness * freshness - cooldown;
  return { s, r: h.r, why: h.why, fairness: +fairness.toFixed(2), freshness: +freshness.toFixed(2), cooldown, sinceUser };
}
const turnsSinceUser = a => q1('SELECT count(*) n FROM messages WHERE chat_id=? AND sender=? AND id>?', chatId, a, lastUserId(chatId)).n;
const hasUnseen = a => !!q1('SELECT 1 FROM messages WHERE chat_id=? AND id>? AND sender<>? LIMIT 1', chatId, sess(chatId, a).last_seen_id, a);
const inQueue = a => ready.some(r => r.chat === chatId && r.agent === a);

function eligible(a) {
  const h = rt[a].hand;
  if (!h || !S.enabled[a] || rt[a].status !== 'idle' || inQueue(a)) return false;
  // The summary waits for slow agents still thinking: they get their say and the summary includes them.
  if (h.why === 'summary') return NAMES.every(n => rt[n].status !== 'thinking') && !ready.some(r => r.chat === chatId);
  if (h.r >= 100) return true;
  return turnsSinceUser(a) < S.turnCap && hasUnseen(a);
}

function pump() {
  publish();
  if (!paused) {
    const inflight = () => NAMES.filter(n => rt[n].status === 'thinking').length + ready.filter(r => r.chat === chatId).length;
    let cands = NAMES.filter(eligible).map(a => ({ a, ...score(a) }));
    cands.sort(S.scheduler === 'broadcast' ? (x, y) => rt[x.a].hand.since - rt[y.a].hand.since : (x, y) => y.s - x.s);
    for (const c of cands) {
      if (inflight() >= S.maxThinkers) break;
      if (S.scheduler !== 'broadcast' && c.s <= 0 && c.r < 100) {
        logDecision('skip', c.a, { score: c.s, detail: c }); rt[c.a].hand = null; continue;
      }
      logDecision('start', c.a, { score: c.s, detail: { ...c, candidates: cands.map(x => [x.a, +x.s.toFixed(2)]) } });
      startTurn(c.a);
    }
  }
  sendState();
}

function intro(a) {
  return `You are "${AGENTS[a].label}" (@${a}), one member of a live group chat running on the user's machine.
Members: the user (a human, full participant) and the agents @claude (Claude), @codex (Codex), @agy (Gemini), @opencode (GLM).
Each turn you receive the messages you haven't seen yet, numbered #N. Your reply is posted to the chat as one message.
Rules:
- This is a chat, not a report: keep each message short (usually under 150 words / 300 Chinese characters), one or two points, no headings.
- Say something new: build on, question or disagree with specific messages and cite them (#N). Don't repeat what others said.
- The user is a participant: when the user has spoken, engage with their points first.
- If you have nothing worth adding right now, answer exactly PASS. If a message @mentions someone else and not you, usually PASS.
- To speak again after others respond, end your message with [HAND]. To ask a member something, @mention them.
- The discussion is read-only: you may read files to inform it, but don't create, edit or delete files or run commands that change anything.
- The full transcript is kept at ${TRANSCRIPT}.\n\n`;
}

async function startTurn(a, retried = false) {
  const chat = chatId, s = sess(chat, a), basedOn = maxId(chat);
  const floor = rt[a].hand?.r >= 100, summary = rt[a].hand?.why === 'summary';
  Object.assign(rt[a], { status: 'thinking', started: Date.now(), live: '', hand: null, note: '', error: '' });
  let msgs, prompt;
  if (s.cli_session_id) {
    msgs = q('SELECT * FROM messages WHERE chat_id=? AND id>? AND sender<>? ORDER BY id', chat, s.last_seen_id, a);
    prompt = `New messages since your last turn:\n\n`;
  } else {
    // New (or lost) session: seed with the recent history, trimmed to stay under the Windows command-line limit.
    msgs = q('SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 40', chat).reverse();
    while (msgs.map(fmt).join('').length > 16000) msgs.shift();
    prompt = intro(a) + `Conversation so far:\n\n`;
  }
  prompt += msgs.map(m => (m.sender === a ? `#${m.id} (you): ${m.text}` : fmt(m))).join('\n\n') || '(no new messages)';
  const k = turnsSinceUser(a) + 1, n = msgs.filter(m => m.sender !== a).length;
  if (summary) prompt += `\n\nThe moderator judged that the discussion has converged. Write a short summary for the user: `
    + `the conclusion, who agreed (cite #N), and caveats still open. No new arguments, no @mentions, no [HAND].`;
  else prompt += `\n\n(Your turn ${k} of at most ${S.turnCap} since the user's last message; ${n} new message(s).`
    + (k >= S.turnCap && !floor ? ' This is your last turn here: PASS unless something essential is missing.)' : ')');
  if (floor && !summary) prompt += `\n\nThe user has given you the floor: please speak now.`;
  prompt += `\n\n(Reply in ${S.language}. Short chat message. Answer exactly PASS if you have nothing new. End with [HAND] to speak again later.)`;
  sendState();

  const res = await runTurn(a, prompt, s.cli_session_id, {
    cwd: WORK, dataDir: DATA,
    onLive: log => { rt[a].live = log; sendStateSoon(); },
  });
  // A resume that fails for a non-quota/auth reason: start a fresh session seeded from our own history.
  if (res.error && s.cli_session_id && !retried && !/quota|auth/.test(res.error)) {
    run('UPDATE agent_sessions SET cli_session_id=NULL WHERE chat_id=? AND agent=?', chat, a);
    logDecision('resume-failed', a, { detail: { error: res.error } });
    rt[a].hand = { r: floor ? 100 : 1, since: Date.now(), why: 'retry' };
    return startTurn(a, true);
  }
  run(`UPDATE agent_sessions SET cli_session_id=?, last_seen_id=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE chat_id=? AND agent=?`,
    res.error ? s.cli_session_id : res.sid || s.cli_session_id, basedOn, res.error ? 'error' : 'ok', chat, a);
  rt[a].status = 'idle';
  if (res.error) {
    rt[a].error = res.error;
    logDecision('error', a, { based_on: basedOn, latency_ms: res.ms, detail: { error: res.error } });
    insertMsg({ chat_id: chat, sender: 'system', kind: 'system', text: `⚠ ${AGENTS[a].label} 出错: ${res.error}`, based_on: basedOn, latency_ms: res.ms });
  } else {
    const hand = /\[HAND\]\s*$/.test(res.text);
    const text = res.text.replace(/\s*\[HAND\]\s*$/, '').trim();
    if (/^PASS[.。!！]?$/i.test(text) && !summary) {
      rt[a].note = 'PASS';
      logDecision('pass', a, { based_on: basedOn, latency_ms: res.ms });
    } else {
      ready.push({ chat, agent: a, text, basedOn, ms: res.ms, hand, done: Date.now() });
      logDecision('ready', a, { based_on: basedOn, latency_ms: res.ms, detail: { hand, chars: text.length } });
    }
  }
  // A PASS or failure may have been the last thing the convergence check was waiting for.
  if (chat === chatId && (res.error || rt[a].note === 'PASS') && wrapRound !== lastUserId(chat)) checkConvergence();
  pump();
}

// ---------- publishing at reading pace ----------
const readMs = text => Math.max(3000, (text.length / S.readSpeed) * 60e3);
let publishTimer;
function publish(force = false) {
  // Replies finished for a chat the user isn't looking at go straight in.
  for (const r of ready.filter(r => r.chat !== chatId)) publishOne(r);
  ready = ready.filter(r => r.chat === chatId);
  if (!force && (Date.now() < readUntil || Date.now() - typingAt < 15e3 || paused)) return;
  const r = ready.shift();
  if (!r) return;
  const m = publishOne(r);
  readUntil = Date.now() + readMs(m.text);
  clearTimeout(publishTimer);
  publishTimer = setTimeout(pump, readUntil - Date.now() + 50);
}

function publishOne(r) {
  const turnNo = q1('SELECT count(*) n FROM messages WHERE chat_id=? AND sender=?', r.chat, r.agent).n + 1;
  const stale = !!q1(`SELECT 1 FROM messages WHERE chat_id=? AND kind='user' AND id>? LIMIT 1`, r.chat, r.basedOn);
  const m = insertMsg({ chat_id: r.chat, sender: r.agent, kind: 'agent', text: r.text, based_on: r.basedOn,
    latency_ms: r.ms, turn_no: turnNo, stale });
  run('UPDATE agent_sessions SET turns=turns+1 WHERE chat_id=? AND agent=?', r.chat, r.agent);
  logDecision('publish', r.agent, { based_on: r.basedOn, message_id: m.id, latency_ms: r.ms,
    detail: { stale, turn_no: turnNo, waited_ms: Date.now() - r.done } });
  // After the wrap-up nobody's hand goes up again, so the round ends quietly until the user posts.
  if (r.chat === chatId && wrapRound !== lastUserId(chatId)) {
    if (S.scheduler === 'broadcast') for (const n of NAMES) { if (n !== r.agent) raise(n, 1, 'broadcast'); }
    if (r.hand) raise(r.agent, 1.5, '[HAND]');
    for (const n of mentions(r.text)) if (n !== r.agent) raise(n, 2, `@ by ${r.agent}`);
    checkConvergence(); // after raising hands: someone just @mentioned hasn't had their say yet
  }
  return m;
}

// ---------- moderator: stop when views have converged ----------
async function checkConvergence() {
  const round = lastUserId(chatId);
  const msgs = q(`SELECT id, sender, kind, text FROM messages WHERE chat_id=? AND id>=? AND kind<>'system' ORDER BY id`, chatId, round);
  // Only judge once everyone woken this round has weighed in: a slow agent still thinking, queued, or waiting
  // for a free slot may yet disagree. (Agents that passed or failed are idle without a hand, so they don't block.)
  const pending = a => S.enabled[a] && !msgs.some(m => m.sender === a)
    && (rt[a].status === 'thinking' || rt[a].hand || inQueue(a));
  if (!S.autoStop || !round || !msgs.some(m => m.kind === 'agent') || NAMES.some(pending)) return;
  const j = await judge(msgs);
  // The round moved on while Jev answered (a new message or a new speaker): the next check will cover it.
  const lastNow = q1(`SELECT max(id) m FROM messages WHERE chat_id=? AND kind<>'system'`, chatId).m;
  if (lastNow !== msgs.at(-1).id || wrapRound === round || NAMES.some(pending)) return;
  if (j.error) return logDecision('judge-error', null, { detail: j });
  mod = { convergence: j.convergence, stalling: j.stalling, msgId: msgs.at(-1).id };
  // Fully converged, or mostly converged while the latest messages only agree/restate.
  const stop = j.convergence >= S.convergeAt / 100 || (j.convergence >= 0.67 && j.stalling >= 0.6);
  logDecision('judge', null, { score: j.convergence, message_id: mod.msgId, latency_ms: j.ms, detail: { ...j, stop } });
  if (!stop) return sendState();
  wrapRound = round;
  for (const n of NAMES) rt[n].hand = null;
  // The member most engaged in this round writes the summary.
  const writer = NAMES.filter(n => S.enabled[n]).sort((x, y) => turnsSinceUser(y) - turnsSinceUser(x))[0];
  rt[writer].hand = { r: 100, since: Date.now(), why: 'summary' };
  logDecision('converged', writer, { score: j.convergence, message_id: mod.msgId, detail: j });
  insertMsg({ chat_id: chatId, sender: 'system', kind: 'system', text: `🧭 主持人：观点已收敛（收敛度 ${Math.round(j.convergence * 100)}%，`
    + `重复度 ${j.stalling.toFixed(2)}）。等思考中的成员说完后请 ${AGENTS[writer].label} 总结，本轮结束；发新消息可继续讨论。` });
  pump();
}

// ---------- SSE ----------
const clients = new Set();
const send = ev => { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); };
function state() {
  const now = Date.now();
  return {
    type: 'state', now, chatId, paused, mod, wrapped: wrapRound === lastUserId(chatId), settings: S, readLeft: Math.max(0, readUntil - now),
    holding: now - typingAt < 15e3,
    chats: q('SELECT id, title FROM chats ORDER BY id DESC'),
    queue: ready.filter(r => r.chat === chatId).map(r => ({ agent: r.agent, basedOn: r.basedOn })),
    members: NAMES.map(n => ({
      name: n, label: AGENTS[n].label, color: AGENTS[n].color, ...rt[n], enabled: S.enabled[n],
      sid: sess(chatId, n).cli_session_id, turns: q1('SELECT count(*) n FROM messages WHERE chat_id=? AND sender=?', chatId, n).n,
      sinceUser: turnsSinceUser(n), score: rt[n].hand && rt[n].status === 'idle' ? +score(n).s.toFixed(2) : null,
    })),
  };
}
const sendState = () => send(state());
let stateTimer;
const sendStateSoon = () => { stateTimer ??= setTimeout(() => { stateTimer = null; sendState(); }, 400); };

// ---------- HTTP ----------
const routes = {
  'POST /api/send'({ text, reply_to }) {
    text = String(text || '').trim();
    if (!text) return;
    typingAt = 0; mod = null;
    const m = insertMsg({ chat_id: chatId, sender: 'user', kind: 'user', text, reply_to: reply_to || null });
    const at = mentions(text);
    const target = reply_to && q1('SELECT sender FROM messages WHERE id=?', reply_to)?.sender;
    if (at.length) for (const n of at) raise(n, 10, '@ by user');
    else for (const n of NAMES) raise(n, n === target ? 3 : 1, n === target ? `reply to #${reply_to}` : 'user message');
    logDecision('user', null, { message_id: m.id, detail: { mentions: at, reply_to: reply_to || null } });
  },
  'POST /api/typing'({ typing }) { typingAt = typing ? Date.now() : 0; },
  'POST /api/next'() { readUntil = 0; publish(true); },
  'POST /api/pause'({ paused: p }) { paused = !!p; run('UPDATE chats SET paused=? WHERE id=?', +paused, chatId); },
  'POST /api/stop'() {
    paused = true; run('UPDATE chats SET paused=1 WHERE id=?', chatId);
    for (const n of NAMES) rt[n].hand = null;
    logDecision('stop', null);
  },
  'POST /api/floor'({ agent }) { if (AGENTS[agent]) { raise(agent, 100, 'floor from user'); logDecision('floor', agent); } },
  'POST /api/lower'({ agent }) { if (AGENTS[agent]) rt[agent].hand = null; },
  'POST /api/settings'(body) {
    for (const k of ['language', 'scheduler']) if (typeof body[k] === 'string' && body[k]) S[k] = body[k];
    if (typeof body.autoStop === 'boolean') S.autoStop = body.autoStop;
    for (const k of ['turnCap', 'readSpeed', 'maxThinkers', 'convergeAt']) if (+body[k] > 0) S[k] = +body[k];
    if (body.enabled) S.enabled = { ...S.enabled, ...body.enabled };
    saveSettings();
  },
  'POST /api/chat/new'({ title }) {
    switchChat(Number(run('INSERT INTO chats(title) VALUES(?)', title || `讨论 ${maxChat() + 1}`).lastInsertRowid));
  },
  'POST /api/chat/switch'({ id }) { if (q1('SELECT 1 FROM chats WHERE id=?', +id)) switchChat(+id); },
};
const maxChat = () => q1('SELECT coalesce(max(id),0) m FROM chats').m;
function switchChat(id) {
  chatId = id; paused = !!q1('SELECT paused FROM chats WHERE id=?', id).paused;
  for (const n of NAMES) rt[n].hand = null;
  readUntil = 0; mod = null; writeTranscript(id);
  send(init());
}
const init = () => ({ type: 'init', messages: q('SELECT * FROM messages WHERE chat_id=? ORDER BY id', chatId), state: state() });

http.createServer((req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  if (key === 'GET /') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(join(ROOT, 'app/index.html')));
  }
  if (key === 'GET /events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    clients.add(res); req.on('close', () => clients.delete(res));
    return res.write(`data: ${JSON.stringify(init())}\n\n`);
  }
  const h = routes[key];
  if (!h) { res.writeHead(404); return res.end(); }
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    try { h(body ? JSON.parse(body) : {}); pump(); res.writeHead(200).end('{}'); }
    catch (e) { console.error(e); res.writeHead(500).end(JSON.stringify({ error: e.message })); }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`agent-chat on http://localhost:${PORT}`));

setInterval(pump, 1000); // thinking timers, reading countdown, typing hold expiry
