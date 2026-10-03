// agent-chat server: SQLite + SSE + scheduler + reading-pace publish queue. No npm dependencies.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AGENTS, runTurn, listModels } from './agents.mjs';
import { judge, novelty } from './moderator.mjs';
import { curate } from './memory.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'data'), WORK = join(ROOT, 'workspace');
// Every discussion is archived as data/discussions/<id>.md plus an index, so agents can look up earlier ones.
const ARCHIVE = join(DATA, 'discussions'), MEMORY = join(DATA, 'memory.md');
mkdirSync(ARCHIVE, { recursive: true }); mkdirSync(WORK, { recursive: true });
const PORT = +process.env.PORT || 3517, HOST = process.env.HOST || '127.0.0.1'; // HOST=0.0.0.0 to serve the LAN
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
for (const col of ['model', 'role']) // role: 'devil' | 'summary' for moderator-requested turns
  if (!db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === col)) db.exec(`ALTER TABLE messages ADD COLUMN ${col} TEXT`);
const q = (sql, ...a) => db.prepare(sql).all(...a);
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

const DEFAULTS = { language: '中文', turnCap: 3, readSpeed: 400, maxThinkers: 2, scheduler: 'algorithm', autoStop: true, convergeAt: 80, noveltyMin: 45, devil: true, circlePause: true, memory: true,
  enabled: Object.fromEntries(NAMES.map(n => [n, true])), models: Object.fromEntries(NAMES.map(n => [n, AGENTS[n].defaultModel])) };
let S = { ...DEFAULTS, ...JSON.parse(q1(`SELECT value FROM settings WHERE key='s'`)?.value || '{}') };
S.models = { ...DEFAULTS.models, ...S.models };
const modelOf = a => S.models[a] || 'default';
let modelLists = {};  // read once from each CLI at startup
listModels().then(l => { modelLists = l; send(init()); });
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
  const id = Number(run(`INSERT INTO messages(chat_id, sender, kind, text, based_on, reply_to, latency_ms, turn_no, stale, model, role)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, m.chat_id, m.sender, m.kind, m.text, m.based_on ?? null, m.reply_to ?? null,
    m.latency_ms ?? null, m.turn_no ?? null, m.stale ? 1 : 0, m.model ?? null, m.role ?? null).lastInsertRowid);
  const msg = q1('SELECT * FROM messages WHERE id=?', id);
  writeTranscript(m.chat_id);
  if (m.chat_id === chatId) send({ type: 'msg', msg });
  return msg;
}

const who = s => (s === 'user' ? '用户 (user)' : AGENTS[s] ? `@${s}` : s);
const describe = a => `@${a} (${AGENTS[a].label} running ${modelOf(a)})`;
const fmt = m => `#${m.id} ${who(m.sender)}${m.reply_to ? ` (回复 #${m.reply_to})` : ''}: ${m.text}`;
const archiveFile = c => join(ARCHIVE, `${c}.md`);
function writeTranscript(c) {
  const chat = q1('SELECT title, created_at FROM chats WHERE id=?', c);
  if (!chat) return;
  writeFileSync(archiveFile(c), `# ${chat.title}\n\n讨论 ${c}，开始于 ${chat.created_at} UTC\n\n`
    + q(`SELECT * FROM messages WHERE chat_id=? AND ${TALK} ORDER BY id`, c).map(fmt).join('\n\n') + '\n');
  writeIndex();
}
// One line per discussion: when, size, the question and (if the moderator wrapped it up) the latest summary.
function writeIndex() {
  const rows = q(`SELECT c.id, c.title, c.created_at,
      (SELECT count(*) FROM messages WHERE chat_id=c.id AND ${TALK}) n,
      (SELECT text FROM messages WHERE chat_id=c.id AND kind='user' ORDER BY id LIMIT 1) q,
      (SELECT text FROM messages WHERE chat_id=c.id AND role='summary' ORDER BY id DESC LIMIT 1) s
    FROM chats c ORDER BY c.id DESC`);
  const one = t => (t || '').replace(/\s+/g, ' ').slice(0, 300);
  writeFileSync(join(ARCHIVE, 'index.md'), '# 往期讨论\n\n每场讨论的全文在同目录的 <编号>.md。\n\n' + rows.map(r =>
    `- 讨论 ${r.id}「${r.title}」${r.created_at.slice(0, 10)}，${r.n} 条消息。问题：${one(r.q)}${r.s ? `\n  结论：${one(r.s)}` : ''}`).join('\n') + '\n');
}
const readMemory = () => (existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8') : '');

// ---------- runtime state ----------
// hand: {r: relevance, since, why}; r >= 100 means the user gave the floor (bypasses cap and "nothing new").
const rt = Object.fromEntries(NAMES.map(n => [n, { status: 'idle', started: 0, live: '', hand: null, note: '', error: '' }]));
let ready = [];          // finished replies waiting to be published: {chat, agent, text, basedOn, ms, hand, turnNo}
let readUntil = 0, typingAt = 0;
let mod = null;                         // latest Jev judgment this round: {convergence, stalling, msgId}
let wrapRound = 0;                      // round (= last user message id) already wrapped up
// Moderator activity. devilAt / circledAt: the round in which devil's advocate / the circling pause already happened.
const jev = { assessing: false, again: false, judging: false, ms: null, downAt: 0, idleNoted: 0, devilAt: 0, circledAt: 0, circlePaused: false };

// Only user and agent messages are the discussion; system/moderator notes are for the UI.
const TALK = `kind IN ('user','agent')`;
const lastTalkId = () => q1(`SELECT coalesce(max(id),0) m FROM messages WHERE chat_id=? AND ${TALK}`, chatId).m;
const note = text => insertMsg({ chat_id: chatId, sender: 'moderator', kind: 'moderator', text });

const MENTION = { claude: 'claude', codex: 'codex', agy: 'agy', gemini: 'agy', opencode: 'opencode', glm: 'opencode' };
const mentions = text => [...new Set([...text.matchAll(/@(\w+)/g)].map(m => MENTION[m[1].toLowerCase()]).filter(Boolean))];

function raise(a, r, why) {
  if (!S.enabled[a]) return;
  const h = rt[a].hand;
  rt[a].hand = { r: Math.max(r, h?.r || 0), since: h?.since || Date.now(), why: h && h.r >= r ? h.why : why };
}

// ---------- scheduler ----------
// Fairness modifies priority, it doesn't decide it: score = relevance × fairness × freshness − cooldown.
// Relevance comes from explicit signals; in jev mode it is scaled by Jev's novelty judgment (0.5 = neutral).
// Explicit user choices (@mention ≥ 10, floor ≥ 100) are never second-guessed.
const jevOn = () => S.scheduler === 'jev' && Date.now() - jev.downAt > 60e3; // fall back to algorithm for 1 min after an error
const novFresh = a => rt[a].nov?.at >= lastTalkId();
function score(a) {
  const h = rt[a].hand;
  const nov = jevOn() && h.r < 10 && novFresh(a) ? rt[a].nov.p : null;
  const msgs = q(`SELECT id, sender FROM messages WHERE chat_id=? AND ${TALK} ORDER BY id DESC LIMIT 50`, chatId);
  const silence = msgs.findIndex(m => m.sender === a);               // messages since a last spoke
  const fairness = 1 + 0.1 * Math.min(silence < 0 ? 10 : silence, 10); // capped: silence helps, but only so much
  const freshness = 1 / (1 + (Date.now() - h.since) / 300e3);         // hands decay over minutes
  const sinceUser = turnsSinceUser(a);
  const cooldown = (silence >= 0 && silence < 2 ? 0.4 : 0) + 0.2 * sinceUser;
  const relevance = nov == null ? h.r : h.r * 2 * nov;
  const s = relevance * fairness * freshness - cooldown;
  return { s, r: h.r, why: h.why, nov, relevance: +relevance.toFixed(2), fairness: +fairness.toFixed(2),
    freshness: +freshness.toFixed(2), cooldown, sinceUser };
}
const turnsSinceUser = a => q1('SELECT count(*) n FROM messages WHERE chat_id=? AND sender=? AND id>?', chatId, a, lastUserId(chatId)).n;
const hasUnseen = a => !!q1(`SELECT 1 FROM messages WHERE chat_id=? AND id>? AND sender<>? AND ${TALK} LIMIT 1`, chatId, sess(chatId, a).last_seen_id, a);
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
      // jev mode: follow-up hands wait for a fresh novelty judgment; the user's own wake-ups don't.
      const followUp = c.r < 10 && c.why !== 'user message';
      if (jevOn() && followUp && !novFresh(c.a)) { assess(); continue; }
      if (jevOn() && followUp && c.nov < S.noveltyMin / 100) {
        logDecision('skip', c.a, { score: c.s, detail: { ...c, reason: 'jev: nothing new' } }); rt[c.a].hand = null; continue;
      }
      if (S.scheduler !== 'broadcast' && c.s <= 0 && c.r < 100) {
        logDecision('skip', c.a, { score: c.s, detail: c }); rt[c.a].hand = null; continue;
      }
      logDecision('start', c.a, { score: c.s, detail: { ...c, candidates: cands.map(x => [x.a, +x.s.toFixed(2)]) } });
      if (c.why === 'Jev') note(`🧭 请 @${c.a} 发言（新意 ${Math.round(c.nov * 100)}%）`);
      startTurn(c.a);
    }
  }
  floorBack();
  maybeCurate();
  sendState();
}

// ---------- Jev scheduler: who would add something new? ----------
async function assess() {
  const round = lastUserId(chatId);
  if (!jevOn() || !round || wrapRound === round) return;
  const at = lastTalkId();
  if (jev.assessing) return void (jev.again ||= at !== jev.at); // re-ask only if the discussion moved on
  jev.at = at;
  const cands = NAMES.filter(a => S.enabled[a] && rt[a].status === 'idle' && !inQueue(a)
    && (turnsSinceUser(a) < S.turnCap || rt[a].hand?.r >= 10) && hasUnseen(a));
  if (!cands.length) return;
  jev.assessing = true; sendState();
  const msgs = q(`SELECT id, sender, text FROM messages WHERE chat_id=? AND id>=? AND ${TALK} ORDER BY id`, chatId, round);
  const r = await novelty(msgs, cands.map(a => ({ name: a, harness: AGENTS[a].label, model: modelOf(a) })));
  jev.assessing = false;
  if (r.error) {
    jev.downAt = Date.now();
    logDecision('jev-error', null, { detail: r });
    note(`🧭 Jev 暂时不可用（${r.error.slice(0, 80)}），1 分钟内改用算法调度。`);
  } else if (lastUserId(chatId) === round && wrapRound !== round) {
    jev.ms = r.ms;
    for (const a of cands) rt[a].nov = { p: r.novelty[a], at };
    logDecision('novelty', null, { latency_ms: r.ms, message_id: at, detail: r.novelty });
    for (const a of cands) if (r.novelty[a] >= S.noveltyMin / 100) raise(a, 1, 'Jev');
  }
  if (jev.again) { jev.again = false; return assess(); }
  pump();
}

// When the room goes quiet without wrapping up, the moderator hands the floor back to the user (once per lull).
let floorTimer;
function floorBack() {
  const quiet = () => !paused && !jev.assessing && !jev.judging && wrapRound !== lastUserId(chatId)
    && NAMES.every(n => rt[n].status !== 'thinking' && !rt[n].hand) && !ready.some(r => r.chat === chatId)
    && q1(`SELECT kind FROM messages WHERE chat_id=? AND ${TALK} ORDER BY id DESC LIMIT 1`, chatId)?.kind === 'agent';
  if (!quiet() || jev.idleNoted === lastTalkId()) return;
  clearTimeout(floorTimer);
  floorTimer = setTimeout(() => {  // give a pending Jev call a moment
    if (!quiet() || jev.idleNoted === lastTalkId()) return;
    jev.idleNoted = lastTalkId();
    const c = mod ? `收敛度 ${Math.round(mod.convergence * 100)}%，` : '';
    note(`🧭 暂时没有人要发言了（${c}没人举手）。轮到你：可以追问、反驳，或 @某人。`);
  }, 1500);
}

// ---------- memory about the user ----------
// Once the whole room is quiet and the user's last message is 20s old, fold what the user newly wrote (in any
// discussion) into data/memory.md. memoryAt = last user message already considered.
const memo = { curating: false, at: null, error: '', retryAt: 0 };
const memoryAt = () => +(q1(`SELECT value FROM settings WHERE key='memoryAt'`)?.value || 0);
async function maybeCurate(force = false) {
  if (memo.curating || (!S.memory && !force) || (!force && Date.now() < memo.retryAt)) return;
  const pending = q(`SELECT m.id, m.text, m.created_at, c.title chat FROM messages m JOIN chats c ON c.id=m.chat_id
    WHERE m.kind='user' AND m.id>? ORDER BY m.id DESC LIMIT 40`, memoryAt()).reverse();
  if (!pending.length) return;
  const quiet = NAMES.every(n => rt[n].status !== 'thinking') && !ready.length;
  if (!force && (!quiet || Date.now() - new Date(pending.at(-1).created_at.replace(' ', 'T') + 'Z') < 20e3)) return;
  memo.curating = true; sendState();
  const r = await curate(readMemory(), pending, { language: S.language, cwd: WORK, dataDir: DATA });
  memo.curating = false; memo.error = r.error || ''; memo.retryAt = r.error ? Date.now() + 10 * 60e3 : 0; // back off after a failure
  if (r.text) { writeFileSync(MEMORY, r.text); memo.at = Date.now(); }
  if (!r.error) run(`INSERT OR REPLACE INTO settings VALUES('memoryAt', ?)`, String(pending.at(-1).id));
  logDecision('memory', null, { message_id: pending.at(-1).id, detail: r.error ? { error: r.error } : { changed: !!r.text } });
  sendState();
}

// Codex reads files only through shell commands and runs in a read-only sandbox; the others have file tools,
// and headless agy ends its turn with no reply when a command is denied.
const SHELL_RULE = {
  codex: 'Your sandbox is read-only: read-only shell commands (cat, rg, ls) are fine for reading files.',
  default: "Don't run shell commands (they are denied, and a denied action ends your turn without a reply).",
};
function intro(a, chat) {
  const memory = S.memory ? readMemory().trim() : '';
  return `You are ${describe(a)}, one member of a live group chat running on the user's machine.
Members: the user (a human, full participant) and the agents ${NAMES.map(describe).join(', ')}.
Each turn you receive the messages you haven't seen yet, numbered #N. Your reply is posted to the chat as one message.
Rules:
- This is a chat, not a report: keep each message short (usually under 150 words / 300 Chinese characters), one or two points, no headings.
- Say something new: build on, question or disagree with specific messages and cite them (#N). Don't repeat what others said.
- The user is a participant: when the user has spoken, engage with their points first.
- If you have nothing worth adding right now, answer exactly PASS. If a message @mentions someone else and not you, usually PASS.
- To speak again after others respond, end your message with [HAND]. To ask a member something, @mention them.
- The discussion is read-only: you may search the web, read web pages and read files to inform it, but don't create, edit or delete files. ${SHELL_RULE[a] || SHELL_RULE.default}
- This discussion's full transcript is ${archiveFile(chat)}. Earlier discussions are archived in ${ARCHIVE}: index.md lists
  them with their conclusions, <id>.md is one discussion. When the user refers to something discussed before, look it up
  there (read / search the files) instead of guessing.
${memory ? `\nWhat you know about the user from earlier discussions (a curated memory; it may be outdated, and what the user
says now wins):\n${memory}\n` : ''}\n`;
}

async function startTurn(a, retried = false) {
  const chat = chatId, s = sess(chat, a), basedOn = maxId(chat);
  const why = rt[a].hand?.why, floor = rt[a].hand?.r >= 100, summary = why === 'summary', invited = why === 'Jev';
  const role = summary ? 'summary' : why === 'devil' ? 'devil' : null;
  Object.assign(rt[a], { status: 'thinking', started: Date.now(), live: '', hand: null, note: '', error: '', role });
  let msgs, prompt;
  if (s.cli_session_id) {
    msgs = q(`SELECT * FROM messages WHERE chat_id=? AND id>? AND sender<>? AND ${TALK} ORDER BY id`, chat, s.last_seen_id, a);
    prompt = `New messages since your last turn:\n\n`;
  } else {
    // New (or lost) session: seed with the recent history, trimmed to stay under the Windows command-line limit.
    msgs = q(`SELECT * FROM messages WHERE chat_id=? AND ${TALK} ORDER BY id DESC LIMIT 40`, chat).reverse();
    while (msgs.map(fmt).join('').length > 16000) msgs.shift();
    prompt = intro(a, chat) + `Conversation so far:\n\n`;
  }
  prompt += msgs.map(m => (m.sender === a ? `#${m.id} (you): ${m.text}` : fmt(m))).join('\n\n') || '(no new messages)';
  const k = turnsSinceUser(a) + 1, n = msgs.filter(m => m.sender !== a).length;
  if (summary) prompt += `\n\nThe moderator judged that the discussion has converged. Write a short summary for the user: `
    + `the conclusion, who agreed (cite #N), and caveats still open. No new arguments, no @mentions, no [HAND].`;
  else prompt += `\n\n(Your turn ${k} of at most ${S.turnCap} since the user's last message; ${n} new message(s).`
    + (k >= S.turnCap && !floor ? ' This is your last turn here: PASS unless something essential is missing.)' : ')');
  if (role === 'devil') prompt += `\n\nThe moderator asks you to play devil's advocate: the group agreed quickly and nobody `
    + `pushed back. Argue the strongest case against the emerging consensus, concretely (cite #N): when would it be wrong, `
    + `what does it cost, what is the best alternative? Say briefly that you are taking the opposing side on request.`;
  else if (floor && !summary) prompt += `\n\nThe user has given you the floor: please speak now.`;
  if (invited) prompt += `\n\nThe moderator invited you to speak: you seem to have something new to add here.`;
  prompt += `\n\n(Reply in ${S.language}. Short chat message. Answer exactly PASS if you have nothing new. End with [HAND] to speak again later. `
    + `${a === 'codex' ? 'Read-only commands only.' : 'No shell commands: use web search, web pages and file reading only.'})`;
  sendState();

  const model = S.models[a];
  const res = await runTurn(a, prompt, s.cli_session_id, {
    cwd: WORK, dataDir: DATA, model,
    onLive: log => { rt[a].live = log; sendStateSoon(); },
  });
  if (!q1('SELECT 1 FROM chats WHERE id=?', chat)) { rt[a].status = 'idle'; return pump(); } // discussion deleted meanwhile
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
    // Agents sometimes write a reply and then a stray "PASS" on its own last line: drop it (a bare PASS stays a pass).
    const text = res.text.replace(/\s*\[HAND\]\s*$/, '').trim().replace(/\n\s*PASS[.。!！]?$/i, '').trim();
    if (/^PASS[.。!！]?$/i.test(text) && !summary) {
      rt[a].note = 'PASS';
      logDecision('pass', a, { based_on: basedOn, latency_ms: res.ms });
    } else {
      ready.push({ chat, agent: a, text, basedOn, ms: res.ms, hand, model: model || 'default', role, done: Date.now() });
      logDecision('ready', a, { based_on: basedOn, latency_ms: res.ms, detail: { hand, chars: text.length } });
    }
  }
  // A PASS or failure may have been the last thing the convergence check was waiting for.
  if (chat === chatId && (res.error || rt[a].note === 'PASS') && wrapRound !== lastUserId(chat)) checkConvergence();
  pump();
}

// ---------- publishing at reading pace ----------
// Reading speed is in Chinese characters per minute, so count what a reader actually reads: each CJK character
// is 1 unit, each English word / number / identifier ~1.5 (400 字/min ≈ 250 words/min); spaces, punctuation and
// markdown don't count. (text.length counted every Latin letter and symbol: ~50% too long on technical replies.)
const readUnits = text => (text.match(/[぀-ヿ㐀-鿿가-힯豈-﫿]/g) || []).length
  + 1.5 * (text.match(/[A-Za-z0-9][A-Za-z0-9_.\-\/]*/g) || []).length;
const readMs = text => Math.max(3000, (readUnits(text) / S.readSpeed) * 60e3);
let publishTimer;
function publish(force = false) {
  // Replies finished for a chat the user isn't looking at go straight in.
  for (const r of ready.filter(r => r.chat !== chatId)) if (q1('SELECT 1 FROM chats WHERE id=?', r.chat)) publishOne(r);
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
    latency_ms: r.ms, turn_no: turnNo, stale, model: r.model, role: r.role });
  run('UPDATE agent_sessions SET turns=turns+1 WHERE chat_id=? AND agent=?', r.chat, r.agent);
  logDecision('publish', r.agent, { based_on: r.basedOn, message_id: m.id, latency_ms: r.ms,
    detail: { stale, turn_no: turnNo, waited_ms: Date.now() - r.done } });
  // After the wrap-up nobody's hand goes up again, so the round ends quietly until the user posts.
  if (r.chat === chatId && wrapRound !== lastUserId(chatId)) {
    if (S.scheduler === 'broadcast') for (const n of NAMES) { if (n !== r.agent) raise(n, 1, 'broadcast'); }
    if (r.hand) raise(r.agent, 1.5, '[HAND]');
    // The consensus has to answer the devil's advocate (in jev mode, only those with something new).
    if (r.role === 'devil') for (const n of NAMES) if (n !== r.agent) raise(n, 1.5, 'answer the devil');
    for (const n of mentions(r.text)) if (n !== r.agent) raise(n, 2, `@ by ${r.agent}`);
    checkConvergence(); // after raising hands: someone just @mentioned hasn't had their say yet
    assess();           // jev mode: who has something new to add now?
  }
  return m;
}

// ---------- moderator: stop when views have converged ----------
async function checkConvergence() {
  const round = lastUserId(chatId);
  const msgs = q(`SELECT id, sender, kind, text, role FROM messages WHERE chat_id=? AND id>=? AND ${TALK} ORDER BY id`, chatId, round);
  // Only judge once everyone woken this round has weighed in: a slow agent still thinking, queued, or waiting
  // for a free slot may yet disagree. (Agents that passed or failed are idle without a hand, so they don't block.)
  // After a devil's advocate, everyone still busy gets to answer first.
  const busy = a => rt[a].status === 'thinking' || rt[a].hand || inQueue(a);
  const devilOpen = msgs.at(-1)?.role === 'devil' || NAMES.some(n => rt[n].role === 'devil' && rt[n].status === 'thinking')
    || NAMES.some(n => rt[n].hand?.why === 'devil') || ready.some(r => r.role === 'devil');
  const pending = a => S.enabled[a] && busy(a) && (devilOpen || !msgs.some(m => m.sender === a));
  if ((!S.autoStop && !S.circlePause) || !round || !msgs.some(m => m.kind === 'agent') || NAMES.some(pending)) return;
  if (NAMES.some(n => rt[n].hand?.why === 'devil' || (rt[n].role === 'devil' && rt[n].status === 'thinking'))) return;
  jev.judging = true; sendState();
  const j = await judge(msgs);
  jev.judging = false;
  // The round moved on while Jev answered (a new message or a new speaker): the next check will cover it.
  if (lastTalkId() !== msgs.at(-1).id || wrapRound === round || NAMES.some(pending)) return pump();
  if (j.error) { logDecision('judge-error', null, { detail: j }); return pump(); }
  const { ms, ...judgment } = j;
  mod = { ...judgment, msgId: msgs.at(-1).id };
  const pc = x => `${Math.round(x * 100)}%`;
  // Fully converged, or mostly converged while the latest messages only agree/restate.
  // A one-member answer (e.g. the user @mentioned one agent) is not a discussion to wrap up.
  const speakers = new Set(msgs.filter(m => m.kind === 'agent').map(m => m.sender)).size;
  const stop = S.autoStop && speakers >= 2 && (j.convergence >= S.convergeAt / 100 || (j.convergence >= 0.67 && j.stalling >= 0.6));
  logDecision('judge', null, { score: j.convergence, message_id: mod.msgId, latency_ms: j.ms, detail: { ...j, stop } });

  // Going in circles: pause and let the user steer (once per round).
  if (!stop && S.circlePause && j.circling >= 0.7 && jev.circledAt !== round) {
    jev.circledAt = round; jev.circlePaused = paused = true; run('UPDATE chats SET paused=1 WHERE id=?', chatId);
    for (const n of NAMES) rt[n].hand = null;
    logDecision('circling', null, { score: j.circling, message_id: mod.msgId, detail: j });
    note(`🧭 讨论在原地打转（${pc(j.circling)}）：同样的论点在来回重复，没有新进展。已暂停，请你定方向：`
      + `补充信息或约束、@某人回答一个具体问题，或者点“继续”。`);
    return pump();
  }
  if (!stop) return pump();

  // Agreed too easily on a judgment call: before wrapping up, someone argues the other side (once per round).
  if (S.devil && j.debatable >= 0.6 && j.challenged < 0.4 && jev.devilAt !== round) {
    jev.devilAt = round;
    for (const n of NAMES) rt[n].hand = null;
    // The quietest member this round takes the opposing side; ties at random.
    const devil = NAMES.filter(n => S.enabled[n]).map(n => [n, turnsSinceUser(n), Math.random()])
      .sort((x, y) => x[1] - y[1] || x[2] - y[2])[0][0];
    rt[devil].hand = { r: 100, since: Date.now(), why: 'devil' };
    logDecision('devil', devil, { score: j.debatable, message_id: mod.msgId, detail: j });
    note(`🧭 大家很快就达成了一致（收敛度 ${pc(j.convergence)}，几乎没人反对），但这是见仁见智的问题。`
      + `收尾前请 @${devil} 唱反调：站到对立面，给出最有力的反驳。`);
    return pump();
  }
  wrapRound = round;
  for (const n of NAMES) rt[n].hand = null;
  // The member most engaged in this round writes the summary; ties go to whoever has summarized least, then random.
  const summaries = a => q1(`SELECT count(*) n FROM decisions WHERE chat_id=? AND event='converged' AND agent=?`, chatId, a).n;
  const writer = NAMES.filter(n => S.enabled[n]).map(n => [n, turnsSinceUser(n), summaries(n), Math.random()])
    .sort((x, y) => y[1] - x[1] || x[2] - y[2] || x[3] - y[3])[0][0];
  rt[writer].hand = { r: 100, since: Date.now(), why: 'summary' };
  logDecision('converged', writer, { score: j.convergence, message_id: mod.msgId, detail: j });
  note(`🧭 观点已收敛（收敛度 ${Math.round(j.convergence * 100)}%，重复度 ${j.stalling.toFixed(2)}）。`
    + `请 @${writer} 总结，本轮到此结束；发新消息可继续讨论。`);
  pump();
}

// ---------- SSE ----------
const clients = new Set();
const send = ev => { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); };
function state() {
  const now = Date.now();
  return {
    type: 'state', now, chatId, paused, mod, wrapped: !!wrapRound && wrapRound === lastUserId(chatId), settings: S, readLeft: Math.max(0, readUntil - now),
    holding: now - typingAt < 15e3,
    chats: listChats(),
    memory: { text: readMemory(), curating: memo.curating, at: memo.at, error: memo.error },
    jev: { on: jevOn(), assessing: jev.assessing, judging: jev.judging, ms: jev.ms, down: S.scheduler === 'jev' && !jevOn() },
    queue: ready.filter(r => r.chat === chatId).map(r => ({ agent: r.agent, basedOn: r.basedOn })),
    members: NAMES.map(n => ({
      name: n, label: AGENTS[n].label, color: AGENTS[n].color, ...rt[n], enabled: S.enabled[n], model: S.models[n],
      sid: sess(chatId, n).cli_session_id, turns: q1('SELECT count(*) n FROM messages WHERE chat_id=? AND sender=?', chatId, n).n,
      sinceUser: turnsSinceUser(n), score: rt[n].hand && rt[n].status === 'idle' ? +score(n).s.toFixed(2) : null,
      nov: novFresh(n) ? rt[n].nov.p : null,
    })),
  };
}
// History list: newest activity first, with size and the latest question as a preview.
const listChats = () => q(`SELECT c.id, c.title, c.created_at,
    (SELECT count(*) FROM messages WHERE chat_id=c.id AND ${TALK}) n,
    (SELECT max(created_at) FROM messages WHERE chat_id=c.id) last,
    (SELECT text FROM messages WHERE chat_id=c.id AND kind='user' ORDER BY id DESC LIMIT 1) preview
  FROM chats c ORDER BY coalesce(last, c.created_at) DESC, c.id DESC`)
  .map(c => ({ ...c, preview: c.preview?.slice(0, 60) || '' }));
const sendState = () => send(state());
let stateTimer;
const sendStateSoon = () => { stateTimer ??= setTimeout(() => { stateTimer = null; sendState(); }, 400); };

// ---------- HTTP ----------
const routes = {
  'POST /api/send'({ text, reply_to, chat_id }) {
    text = String(text || '').trim();
    if (!text) return;
    // The current discussion is shared by all windows: refuse a message typed while looking at another one.
    if (chat_id && +chat_id !== chatId) throw new Error('当前讨论已在别的窗口切换，消息未发送，请确认后重发。');
    typingAt = 0; mod = null;
    if (jev.circlePaused) { jev.circlePaused = paused = false; run('UPDATE chats SET paused=0 WHERE id=?', chatId); } // the user set a direction
    // An untitled discussion is named after its first question.
    const c = q1('SELECT title FROM chats WHERE id=?', chatId);
    if (/^讨论 \d+$/.test(c.title) && !q1(`SELECT 1 FROM messages WHERE chat_id=? AND kind='user'`, chatId))
      run('UPDATE chats SET title=? WHERE id=?', text.replace(/\s+/g, ' ').slice(0, 30), chatId);
    const m = insertMsg({ chat_id: chatId, sender: 'user', kind: 'user', text, reply_to: reply_to || null });
    const at = mentions(text);
    const target = reply_to && q1('SELECT sender FROM messages WHERE id=?', reply_to)?.sender;
    if (at.length) for (const n of at) raise(n, 10, '@ by user');
    else for (const n of NAMES) raise(n, n === target ? 3 : 1, n === target ? `reply to #${reply_to}` : 'user message');
    logDecision('user', null, { message_id: m.id, detail: { mentions: at, reply_to: reply_to || null } });
  },
  'POST /api/typing'({ typing }) { typingAt = typing ? Date.now() : 0; },
  'POST /api/next'() { readUntil = 0; publish(true); },
  'POST /api/pause'({ paused: p }) { paused = !!p; jev.circlePaused = false; run('UPDATE chats SET paused=? WHERE id=?', +paused, chatId); },
  'POST /api/stop'() {
    paused = true; run('UPDATE chats SET paused=1 WHERE id=?', chatId);
    for (const n of NAMES) rt[n].hand = null;
    logDecision('stop', null);
  },
  'POST /api/floor'({ agent }) { if (AGENTS[agent]) { raise(agent, 100, 'floor from user'); logDecision('floor', agent); } },
  'POST /api/lower'({ agent }) { if (AGENTS[agent]) rt[agent].hand = null; },
  'POST /api/settings'(body) {
    for (const k of ['language', 'scheduler']) if (typeof body[k] === 'string' && body[k]) S[k] = body[k];
    for (const k of ['autoStop', 'devil', 'circlePause', 'memory']) if (typeof body[k] === 'boolean') S[k] = body[k];
    for (const k of ['turnCap', 'readSpeed', 'maxThinkers', 'convergeAt', 'noveltyMin']) if (+body[k] > 0) S[k] = +body[k];
    if (body.enabled) S.enabled = { ...S.enabled, ...body.enabled };
    // Only models a CLI listed (or its default) are accepted; the next turn uses it and resumes the same session.
    for (const [a, m] of Object.entries(body.models || {}))
      if (AGENTS[a] && (m === AGENTS[a].defaultModel || modelLists[a]?.some(x => x.id === m))) {
        S.models[a] = m; logDecision('model', a, { detail: { model: m } });
      }
    saveSettings();
  },
  'POST /api/chat/new'({ title }) {
    switchChat(Number(run('INSERT INTO chats(title) VALUES(?)', title || `讨论 ${maxChat() + 1}`).lastInsertRowid));
  },
  'POST /api/chat/switch'({ id }) { if (q1('SELECT 1 FROM chats WHERE id=?', +id)) switchChat(+id); },
  'POST /api/chat/rename'({ id, title }) {
    title = String(title || '').trim().slice(0, 80);
    if (title) run('UPDATE chats SET title=? WHERE id=?', title, +id);
  },
  // Deletes the discussion with its messages, agent session records and decision log (CLI sessions stay in each CLI).
  // The user can correct the memory directly; "curate" folds in new messages now.
  'POST /api/memory'({ text }) {
    const t = String(text ?? '').trim();
    writeFileSync(MEMORY, t ? `${t}\n` : ''); memo.at = Date.now(); logDecision('memory-edit', null);
  },
  'POST /api/memory/curate'() { maybeCurate(true); },
  'POST /api/chat/delete'({ id }) {
    id = +id;
    if (!q1('SELECT 1 FROM chats WHERE id=?', id)) return;
    for (const t of ['messages', 'agent_sessions', 'decisions']) run(`DELETE FROM ${t} WHERE chat_id=?`, id);
    run('DELETE FROM chats WHERE id=?', id);
    rmSync(archiveFile(id), { force: true }); writeIndex();
    ready = ready.filter(r => r.chat !== id);
    if (id === chatId) switchChat(q1('SELECT max(id) m FROM chats').m || Number(run(`INSERT INTO chats(title) VALUES('讨论 1')`).lastInsertRowid));
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
const maxChat = () => q1('SELECT coalesce(max(id),0) m FROM chats').m;
function switchChat(id) {
  chatId = id; paused = !!q1('SELECT paused FROM chats WHERE id=?', id).paused; jev.circlePaused = false;
  for (const n of NAMES) rt[n].hand = null;
  readUntil = 0; mod = null; writeTranscript(id);
  send(init());
}
const init = () => ({ type: 'init', messages: q('SELECT * FROM messages WHERE chat_id=? ORDER BY id', chatId), state: state(), modelLists });

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
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && getRoutes[url.pathname]) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(getRoutes[url.pathname](url.searchParams)));
  }
  if (key === 'GET /api/export') { // markdown download of one discussion
    const c = q1('SELECT * FROM chats WHERE id=?', +url.searchParams.get('id'));
    if (!c) { res.writeHead(404); return res.end(); }
    const body = `# ${c.title}\n\n` + q('SELECT * FROM messages WHERE chat_id=? ORDER BY id', c.id)
      .map(m => m.kind === 'moderator' ? `> ${m.text}` : `**${fmt(m).replace(/^(#\d+ \S+)/, '$1**')}`).join('\n\n') + '\n';
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(c.title)}.md` });
    return res.end(body);
  }
  const h = routes[key];
  if (!h) { res.writeHead(404); return res.end(); }
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    try { h(body ? JSON.parse(body) : {}); pump(); res.writeHead(200).end('{}'); }
    catch (e) { console.error(e); res.writeHead(500).end(JSON.stringify({ error: e.message })); }
  });
}).listen(PORT, HOST, () => console.log(`agent-chat on http://${HOST}:${PORT}`));

for (const c of q('SELECT id FROM chats')) writeTranscript(c.id); // archive discussions from before the archive existed
setInterval(pump, 1000); // thinking timers, reading countdown, typing hold expiry
