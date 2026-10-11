// The room: the scheduler (pump: who starts thinking now), a member's turn from prompt to queued reply, publishing at
// reading pace, and the moderator's hooks (Jev novelty, convergence wrap-up, devil's advocate, circling, the lull
// note, stance changes), plus the user's actions on the room. Mode-specific turn order lives in flows.mjs.
//
// Turn lifecycle: hand raised (runtime.raise) → eligible and best-scored in pump() → startTurn (status 'thinking')
// → reply parsed → addReady (queued, saved) → publish() releases one per reading time → publishOne posts it,
// applies its markers and raises the next hands. A stopped turn posts nothing and leaves the flow where it was.
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { runTurn } from './agents.mjs';
import { judge, novelty, classifyMode, stanceShift } from './moderator.mjs';
import { parseHost } from './game.mjs';
import { MODES, parseReply, applyNotes } from './modes.mjs';
import { curate } from './memory.mjs';
import { synth, speechOn, speakable, defaultVoice } from './speech.mjs';
import { q, q1, run, getSetting, setSetting } from './db.mjs';
import { DATA, SHARED, WORK, UPLOADS, MEMORY, RUNAS, MIME, wsOf, inWork, extOf, readMemory, commitShared } from './workspace.mjs';
import { S, NAMES, memberConfigs, memberOrder, atOf, aliasOf, tx, replyLang } from './config.mjs';
import { chatId, paused, setPaused, setCurrent, endCirclePause, chatExists, chatState, saveState, chatMode, rules, sess, maxId,
  lastUserId, lastTalkId, turnsSinceUser, TALK, HEARS, UNSEEN, logDecision, insertMsg, note, nickOf, setNick, mentions, fmt,
  withStance, userPlays, archiveSoon, who, dmTo } from './chats.mjs';
import { rt, raise, lowerAll, pace, ready, addReady, queued, inQueue, dropReady, releaseHeld, dropHeld, busy, thinking, tell,
  wrapRound, setWrapRound, wrapped, setPump } from './runtime.mjs';
import { wake, relay, advanceDebate, finishDebate, rewindDebate, gameOrder, gameTalkDone, hostDone, userPlay, resumeGame, audit } from './flows.mjs';
import { startJob, startTask, jobReport, running } from './jobs.mjs';
import { maybeOutsider } from './outsider.mjs';
import { intro, turnAsk } from './prompts.mjs';
import { scoreHand, readMs, mayPublish } from './schedule.mjs';
import { sendState, sendStateSoon, resync } from './sse.mjs';

// Moderator activity. devilAt / circledAt: the round in which devil's advocate / the circling pause already happened.
export const jev = { assessing: false, again: false, judging: false, judgeAgain: false, ms: null, downAt: 0, idleNoted: 0, devilAt: 0, circledAt: 0 };
export let mod = null; // latest Jev judgment this round: {convergence, stalling, …, msgId}
// Executing code is only offered when the OS confines the agents (AGENT_USER) and the setting is on.
export const execOn = () => !!RUNAS && S.exec;

// ---------- the opening: Auto picks the mode, then the room waits a moment ----------
export const classifying = new Set(); // chats whose first question Jev is classifying: no turn starts with a guessed mode
// msg: the user message that started the discussion; the room wakes once its mode is known.
async function classifyChat(c, msg) {
  const question = q1(`SELECT text FROM messages WHERE chat_id=? AND kind='user' ORDER BY id LIMIT 1`, c)?.text;
  if (!question) return;
  classifying.add(c); sendState();
  const r = await classifyMode(question);
  classifying.delete(c);
  if (r.error || !MODES[r.mode]) {
    logDecision('mode-error', null, { detail: r });
  } else if (chatMode(c).mode === 'auto') { // the user may have picked a mode meanwhile
    run('UPDATE chats SET auto_mode=? WHERE id=?', r.mode, c);
    logDecision('mode', null, { score: r.probabilities[r.mode], latency_ms: r.ms, detail: { source: 'jev', ...r } });
    if (c === chatId) note(tx('🧭 讨论模式：{mode}（Jev 判断，{p}%）。', { mode: tx(MODES[r.mode].label), p: Math.round(r.probabilities[r.mode] * 100) })
      + (msg ? tx('{s} 秒后开始，不对的话现在在顶栏换模式。', { s: OPEN_HOLD / 1e3 }) : tx('可以在顶栏随时切换。')));
  }
  if (msg && c === chatId) holdOpening(c, msg);
  pump();
}
// Auto's pick can be wrong (a pasted prompt the user forgot to pick a mode for), and the first turns set the discussion
// up (debate sides, a game's host), so the room waits OPEN_HOLD after Jev picks: switching the mode, or "现在开始",
// starts it at once in the mode then in force. Not kept over a restart (the user's next message wakes the room).
const OPEN_HOLD = 10e3;
export let opening = null; // {chat, msg, until, timer}
function holdOpening(c, msg) {
  clearTimeout(opening?.timer);
  opening = { chat: c, msg, until: Date.now() + OPEN_HOLD, timer: setTimeout(() => openNow(c), OPEN_HOLD) };
  sendState();
}
export function openNow(c, wakeIt = true) {
  if (opening?.chat !== c) return;
  const { msg, until } = opening;
  clearTimeout(opening.timer); opening = null;
  logDecision('opening', null, { message_id: msg.id, detail: { mode: chatMode(c).effective, leftMs: Math.max(0, until - Date.now()), started: wakeIt } });
  if (wakeIt && c === chatId) wake(msg);
  pump();
}

// Research mode: the discussion's opening question is answered independently: until the first reply is published,
// everyone woken starts at once, so nobody answers after reading another's answer. Most of what multi-agent debate
// gains comes from independent answers, and discussion mostly adds conformity (Debate or Vote, NeurIPS 2025).
// Follow-up questions are discussed normally.
const blindOpen = () => S.blind && rules(chatId).blindOpening && lastUserId(chatId) > 0
  && !q1(`SELECT 1 FROM messages WHERE chat_id=? AND kind='agent'`, chatId);

// ---------- scheduler ----------
// Relevance comes from explicit signals; in jev mode it is scaled by Jev's novelty judgment (0.5 = neutral).
// Explicit user choices (@mention ≥ 10, floor ≥ 100) are never second-guessed.
export const jevOn = () => S.scheduler === 'jev' && Date.now() - jev.downAt > 60e3; // fall back to algorithm for 1 min after an error
export const novFresh = a => rt[a].nov?.at >= lastTalkId();
export function score(a) {
  const hand = rt[a].hand;
  const msgs = q(`SELECT id, sender FROM messages WHERE chat_id=? AND ${TALK} ORDER BY id DESC LIMIT 50`, chatId);
  return scoreHand({ hand, nov: jevOn() && hand.r < 10 && novFresh(a) ? rt[a].nov.p : null,
    silence: msgs.findIndex(m => m.sender === a), sinceUser: turnsSinceUser(a) });
}
const hasUnseen = a => !!q1(`SELECT 1 FROM messages WHERE chat_id=? AND id>? AND ${UNSEEN} AND ${HEARS} LIMIT 1`, chatId, sess(chatId, a).last_seen_id, a, a, a);
// Hands that start whatever the turn cap and Jev say: everyone's one answer after a debate, a game, a finished job, an outsider.
const UNCAPPED = ['after the debate', 'after the game', 'job', 'outsider'];

function eligible(a) {
  const h = rt[a].hand;
  if (!h || !S.enabled[a] || rt[a].status !== 'idle' || inQueue(a)) return false;
  // The summary waits for slow agents still thinking: they get their say and the summary includes them.
  if (h.why === 'summary') return !NAMES.some(thinking) && !queued().length;
  // A game's orders start together, once the last talk reply is out.
  if (h.game?.phase === 'orders') return !queued().length;
  // Relay, debate and game turns follow one another: the next starts once the previous reply is published.
  if (rules(chatId).flow !== 'free' && busy()) return false;
  // Floor from the user, a debate slot, and the round after a debate (whatever was said during it) aren't capped.
  // Neither is a member woken by its finished background job (it must hear the result, whatever the turn count).
  // An outsider's report gets one answer from everyone too.
  if (h.r >= 100 || h.slot != null || h.game || UNCAPPED.includes(h.why)) return true;
  return turnsSinceUser(a) < S.turnCap && hasUnseen(a);
}

// Runs on every event and every second: publishes what is due, starts the best-scoring eligible hands.
export function pump() {
  publish();
  releaseHeld();
  if (!paused && !classifying.has(chatId)) {
    const inflight = () => NAMES.filter(thinking).length + queued().length;
    let cands = NAMES.filter(eligible).map(a => ({ a, ...score(a) }));
    cands.sort(S.scheduler === 'broadcast' ? (x, y) => rt[x.a].hand.since - rt[y.a].hand.since : (x, y) => y.s - x.s);
    const blind = blindOpen(), free = rules(chatId).flow === 'free';
    for (const c of cands) {
      if (!blind && rt[c.a].hand.game?.phase !== 'orders' && inflight() >= S.maxThinkers) break;
      // jev mode: follow-up hands wait for a fresh novelty judgment; the user's own wake-ups don't, and neither does
      // everyone's one turn after a debate (each says what they actually think, or passes).
      const opener = c.why === 'user message' || UNCAPPED.includes(c.why);
      const followUp = free && c.r < 10 && !opener;
      if (jevOn() && followUp && !novFresh(c.a)) {
        // a hand Jev won't judge (e.g. a member at the turn cap) is dropped, or it would ask Jev again every second
        if (assessable(c.a)) assess(); else { logDecision('skip', c.a, { score: c.s, detail: { ...c, reason: 'not assessable' } }); rt[c.a].hand = null; }
        continue;
      }
      if (jevOn() && followUp && c.nov < S.noveltyMin / 100) {
        logDecision('skip', c.a, { score: c.s, detail: { ...c, reason: 'jev: nothing new' } }); rt[c.a].hand = null; continue;
      }
      if (S.scheduler !== 'broadcast' && c.s <= 0 && c.r < 100 && !opener) {
        logDecision('skip', c.a, { score: c.s, detail: c }); rt[c.a].hand = null; continue;
      }
      if (blind) {
        rt[c.a].hand.blind = true;
        if (jev.blindAt !== lastUserId(chatId)) { jev.blindAt = lastUserId(chatId); note(tx('🧭 研究模式：先请大家各自独立作答（互相看不到），答完再互相讨论。')); }
      }
      logDecision('start', c.a, { score: c.s, detail: { ...c, blind, candidates: cands.map(x => [x.a, +x.s.toFixed(2)]) } });
      if (c.why === 'Jev') note(tx('🧭 请 @{a} 发言（新意 {p}%）', { a: atOf(c.a), p: Math.round(c.nov * 100) }));
      startTurn(c.a);
    }
  }
  floorBack();
  maybeCurate();
  sendState();
}
setPump(pump);

// ---------- Jev scheduler: who would add something new? ----------
const assessable = a => S.enabled[a] && rt[a].status === 'idle' && !inQueue(a)
  && (turnsSinceUser(a) < S.turnCap || rt[a].hand?.r >= 10) && hasUnseen(a);
async function assess() {
  const round = lastUserId(chatId);
  if (!jevOn() || !round || wrapRound === round || rules(chatId).flow !== 'free') return;
  const at = lastTalkId();
  if (jev.assessing) return void (jev.again ||= at !== jev.at); // re-ask only if the discussion moved on
  jev.at = at;
  const cands = NAMES.filter(assessable);
  if (!cands.length) return;
  jev.assessing = true; sendState();
  const msgs = q(`SELECT id, sender, text, stance FROM messages WHERE chat_id=? AND id>=? AND ${TALK} ORDER BY id`, chatId, round)
    .map(m => ({ ...m, text: withStance(m) }));
  const r = await novelty(msgs, cands.map(a => ({ name: a, harness: memberConfigs[a].harness, model: S.models[a] || 'default' })));
  jev.assessing = false;
  if (r.error) {
    jev.downAt = Date.now();
    logDecision('jev-error', null, { detail: r });
    note(tx('🧭 Jev 暂时不可用（{err}），1 分钟内改用算法调度。', { err: r.error.slice(0, 80) }));
  } else if (lastUserId(chatId) === round && wrapRound !== round) {
    jev.ms = r.ms;
    for (const a of cands) if (rt[a]) rt[a].nov = { p: r.novelty[a], at };
    logDecision('novelty', null, { latency_ms: r.ms, message_id: at, detail: r.novelty });
    for (const a of cands) if (rt[a] && r.novelty[a] >= S.noveltyMin / 100) raise(a, 1, 'Jev');
  }
  if (jev.again) { jev.again = false; return assess(); }
  pump();
}

// When the room goes quiet without wrapping up, the moderator hands the floor back to the user (once per lull).
let floorTimer;
function floorBack() {
  const quiet = () => !paused && !jev.assessing && !jev.judging && !wrapped() && !['debate', 'game'].includes(rules(chatId).flow)
    && NAMES.every(n => rt[n].status !== 'thinking' && !rt[n].hand) && !queued().length
    && q1(`SELECT kind FROM messages WHERE chat_id=? AND ${TALK} ORDER BY id DESC LIMIT 1`, chatId)?.kind === 'agent';
  if (!quiet() || jev.idleNoted === lastTalkId()) return;
  clearTimeout(floorTimer);
  floorTimer = setTimeout(() => {  // give a pending Jev call a moment
    if (!quiet() || jev.idleNoted === lastTalkId()) return;
    jev.idleNoted = lastTalkId();
    const c = mod ? tx('收敛度 {p}%，', { p: Math.round(mod.convergence * 100) }) : '';
    note(tx('🧭 暂时没有人要发言了（{c}没人举手）。轮到你：可以追问、反驳，或 @某人。', { c }));
  }, 1500);
}

// ---------- memory about the user ----------
// Once the whole room is quiet and the user's last message is 20s old, fold what the user newly wrote (in any
// discussion) into data/memory.md. memoryAt = last user message already considered.
export const memo = { curating: false, at: null, error: '', retryAt: 0 };
const memoryAt = () => +(getSetting('memoryAt') || 0);
export async function maybeCurate(force = false) {
  if (memo.curating || (!S.memory && !force) || (!force && Date.now() < memo.retryAt)) return;
  const pending = q(`SELECT m.id, m.text, m.created_at, c.title chat FROM messages m JOIN chats c ON c.id=m.chat_id
    WHERE m.kind='user' AND m.dm IS NULL AND m.id>? ORDER BY m.id DESC LIMIT 40`, memoryAt()).reverse();
  if (!pending.length) return;
  const quiet = !NAMES.some(thinking) && !ready.length;
  if (!force && (!quiet || Date.now() - new Date(pending.at(-1).created_at.replace(' ', 'T') + 'Z') < 20e3)) return;
  const curator = memberOrder().find(n => S.enabled[n] && rt[n].status === 'idle');
  if (!curator) { if (force) { memo.error = tx('请先启用一位空闲成员来整理记忆'); sendState(); } return; }
  const member = { ...memberConfigs[curator], model: S.models[curator] || '' };
  memo.curating = true; memo.abort = new AbortController(); sendState();
  // Facts without a month get the month of their latest source message, so the curator can tell old from recent.
  const dated = readMemory().replace(/[(（]\s*(#\d+(?:\s*[,，、]\s*#\d+)*)\s*[)）]\s*$/gm, (all, refs) => {
    const at = q1(`SELECT max(created_at) at FROM messages WHERE id IN (${refs.match(/\d+/g).join(',')})`)?.at;
    return at ? `(${refs}, ${at.slice(0, 7)})` : all;
  });
  const r = await curate(dated, pending, { language: replyLang(), cwd: wsOf(curator), dataDir: DATA,
    harness: member.harness, model: member.model, member, signal: memo.abort.signal }).catch(e => ({ error: e.message }));
  // back off after a failure; a stopped curation just tries again later, quietly
  memo.curating = false; memo.error = r.error === 'stopped' ? '' : r.error || ''; memo.retryAt = r.error ? Date.now() + 10 * 60e3 : 0;
  if (r.text) { writeFileSync(MEMORY, r.text); memo.at = Date.now(); }
  if (!r.error) setSetting('memoryAt', String(pending.at(-1).id));
  logDecision('memory', curator, { message_id: pending.at(-1).id, detail: { model: member.model || 'default', ...(r.error ? { error: r.error } : { changed: !!r.text }) } });
  sendState();
}
export function editMemory(text) {
  const t = String(text ?? '').trim();
  writeFileSync(MEMORY, t ? `${t}\n` : ''); memo.at = Date.now(); logDecision('memory-edit', null);
}

// ---------- a member's turn ----------
// A member's [FILE] lines: files under WORK copied into the discussion's uploads, like the user's attachments.
function attachFiles(a, chat, paths) {
  const files = [], bad = [];
  for (const f of paths) {
    const p = inWork(resolve(wsOf(a), f)), size = p ? statSync(p).size : 0;
    if (!p || size > 20e6) { bad.push(f); continue; }
    const dir = join(UPLOADS, String(chat)), name = basename(p), stored = `${Date.now().toString(36)}-${name.replace(/[^\p{L}\p{N}._-]+/gu, '_')}`;
    mkdirSync(dir, { recursive: true });
    copyFileSync(p, join(dir, stored));
    files.push({ file: `${chat}/${stored}`, name, size, type: MIME[extOf(name)] || '' });
  }
  if (bad.length) tell(a, { kind: 'note', chat, summary: `Not attached (no such file under ${WORK}, or over 20 MB): ${bad.join(', ')}.` });
  return files;
}
// Each member's own voice: chosen in the UI, else the Azure pool by member order (stable: creation order).
export const voiceOf = a => S.ttsVoices?.[a] || defaultVoice(Math.max(0, NAMES.indexOf(a)));
// "#58" is read as the name of whoever wrote #58 (the user: the name set under 关于你, else 用户); unknown numbers are dropped.
const refName = id => { const s = q1('SELECT sender FROM messages WHERE id=?', id)?.sender;
  return s === 'user' ? (S.userName || '用户') : s && memberConfigs[s] ? aliasOf(s) : null; };
// No "name:" prefix: each member has its own voice.
export const spoken = (a, text) => speakable(text, refName);

async function startTurn(a, retried = false) {
  const chat = chatId, s = sess(chat, a), basedOn = maxId(chat);
  const hand0 = rt[a].hand, { why, blind, slot, seat, game: play } = hand0 || {};
  const floor = rt[a].hand?.r >= 100, summary = why === 'summary', invited = why === 'Jev';
  const r = rules(chat), d = chatState(chat).debate, phase = slot != null ? d.script[slot].phase : null;
  const role = summary ? 'summary' : why === 'devil' ? 'devil' : phase === 'verdict' ? 'verdict' : null;
  Object.assign(rt[a], { status: 'thinking', started: Date.now(), live: '', hand: null, note: '', error: '', role, play });
  const exec = execOn();
  let msgs, prompt;
  if (s.cli_session_id) {
    msgs = q(`SELECT * FROM messages WHERE chat_id=? AND id>? AND ${UNSEEN} AND ${HEARS} ORDER BY id`, chat, s.last_seen_id, a, a, a);
    prompt = `New messages since your last turn:\n\n`;
  } else {
    // New (or lost) session: seed with the recent history, trimmed to stay under the Windows command-line limit.
    msgs = q(`SELECT * FROM messages WHERE chat_id=? AND ${HEARS} ORDER BY id DESC LIMIT 40`, chat, a, a).reverse();
    while (msgs.map(fmt).join('').length > 16000) msgs.shift();
    prompt = intro(a, chat, exec) + `Conversation so far:\n\n`;
  }
  prompt += msgs.map(m => (m.sender === a && m.role !== 'outsider' ? `#${m.id} (you${m.dm ? ` → ${who(m.dm)}, private` : ''}): ${m.text}` : fmt(m))).join('\n\n') || '(no new messages)';
  const k = turnsSinceUser(a) + 1, n = msgs.filter(m => m.sender !== a).length;
  prompt += jobReport(a, chat);
  prompt += turnAsk(a, chat, { r, d, phase, k, n, floor, summary, invited, blind, role, play, exec });
  sendState();

  const model = S.models[a];
  rt[a].abort = new AbortController();
  const res = await runTurn(memberConfigs[a].harness, prompt, s.cli_session_id, {
    cwd: wsOf(a), dataDir: DATA, shared: SHARED, model, exec, member: memberConfigs[a] && { ...memberConfigs[a], model },
    onLive: log => { rt[a].live = log; sendStateSoon(); }, signal: rt[a].abort.signal,
  }).catch(e => ({ error: `${memberConfigs[a]?.harness}: ${e.message}`, ms: 0 }));
  rt[a].abort = null;
  if (execOn()) commitShared(a, `${a}: turn after #${basedOn}`);
  if (!chatExists(chat)) { rt[a].status = 'idle'; return pump(); } // discussion deleted meanwhile
  // Stopped by the user: nothing is posted, the session isn't advanced (the messages count as unseen next time),
  // and the flow doesn't move on, so a debate slot or the relay baton is played again when the discussion resumes.
  if (res.error === 'stopped') {
    Object.assign(rt[a], { status: 'idle', note: tx('已停止') });
    logDecision('cancelled', a, { based_on: basedOn, latency_ms: res.ms });
    return pump();
  }
  // A resume that fails for a non-quota/auth reason: start a fresh session seeded from our own history.
  if (res.error && s.cli_session_id && !retried && !/quota|auth/.test(res.error)) {
    run('UPDATE agent_sessions SET cli_session_id=NULL WHERE chat_id=? AND agent=?', chat, a);
    logDecision('resume-failed', a, { detail: { error: res.error } });
    rt[a].hand = { ...hand0, r: floor ? 100 : hand0?.r ?? 1, since: Date.now() }; // the same turn: debate slot, game phase
    return startTurn(a, true);
  }
  run(`UPDATE agent_sessions SET cli_session_id=?, last_seen_id=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE chat_id=? AND agent=?`,
    res.error ? s.cli_session_id : res.sid || s.cli_session_id, basedOn, res.error ? 'error' : 'ok', chat, a);
  rt[a].status = 'idle';
  if (play && play.phase !== 'host') audit(chat, a, rt[a].live);
  if (play?.phase === 'orders') return void (gameOrder(chat, a, play, res), pump()); // to the host only, never posted
  let text = '', hostRes = null;
  if (res.error) {
    rt[a].error = res.error;
    logDecision('error', a, { based_on: basedOn, latency_ms: res.ms, detail: { error: res.error } });
    insertMsg({ chat_id: chat, sender: 'system', kind: 'system', text: tx('⚠ @{a} 出错: {err}', { a: atOf(a), err: res.error }), based_on: basedOn, latency_ms: res.ms });
  } else {
    // the host's reply: its phase marker and ledger come off first
    hostRes = play?.phase === 'host' ? parseHost(res.text) : null;
    const reply = parseReply(hostRes ? hostRes.body : res.text), { hand, stance, notes } = reply, jobs = exec ? reply.jobs : [], todo = exec ? reply.tasks : [];
    // private messages: in a game to another player (or the host), in a formal debate to a teammate; players 3 a turn
    const cs = chatState(chat), gm = cs.game, players = r.flow === 'game' ? [...gm?.players || [], ...gm?.host ? [gm.host] : []]
      : r.flow === 'debate' && !cs.debate?.done ? [cs.debate?.pro, cs.debate?.con].find(s => s?.includes(a)) || [] : [];
    const dms = reply.dms.map(x => ({ to: dmTo(x.to), text: x.text })).filter(x => x.to !== a && players.includes(x.to))
      .slice(0, play?.phase === 'host' ? 12 : 3);
    const files = attachFiles(a, chat, reply.files);
    text = reply.text || (jobs.length || todo.length ? '（启动后台任务）' : '');
    if (dms.length && /^PASS[.。!！]?$/i.test(text)) text = '';
    if ((/^PASS[.。!！]?$/i.test(text) || (!text && !dms.length && !files.length)) && !summary && !jobs.length && !todo.length) {
      rt[a].note = 'PASS'; text = '';
      logDecision('pass', a, { based_on: basedOn, latency_ms: res.ms });
    } else {
      addReady({ chat, agent: a, text, basedOn, ms: res.ms, hand, stance, notes, jobs, todo, dms, files, nick: reply.nick, seat, slot, model: model || 'default', role, done: Date.now() });
      // A browser is reading aloud: synthesize while the reply waits in the queue, so it plays without delay.
      if (speechOn() && Date.now() - pace.ttsActiveAt < 120e3) synth(spoken(a, text), voiceOf(a)).catch(() => {});
      logDecision('ready', a, { based_on: basedOn, latency_ms: res.ms, detail: { hand, chars: text.length } });
    }
  }
  // The flow moves on: the relay hands the baton on, the debate goes to its next slot (a published reply first waits
  // for its reading time: the next turn starts once it is out).
  const passed = !!res.error || rt[a].note === 'PASS';
  if (chat === chatId && rules(chat).flow === 'relay') relay(a, passed ? '' : text);
  if (slot != null) advanceDebate(chat, slot, !passed);
  if (play?.phase === 'talk') gameTalkDone(chat, play);
  if (play?.phase === 'host') hostDone(chat, play, res.error ? null : hostRes);
  // A PASS or failure may have been the last thing the convergence check was waiting for.
  if (chat === chatId && passed && !wrapped(chat)) checkConvergence();
  pump();
}

// ---------- publishing at reading pace ----------
let publishTimer;
function publish(force = false) {
  // Replies finished for a chat the user isn't looking at go straight in.
  for (const r of dropReady(r => r.chat !== chatId)) if (chatExists(r.chat)) publishOne(r);
  if (!force && !mayPublish(pace, paused)) return;
  const r = ready[0];
  if (!r) return;
  dropReady(x => x === r); // off the queue first: a reply that fails to publish must not be retried every second
  const m = publishOne(r);
  pace.readUntil = Date.now() + readMs(m.text, S.readSpeed);
  clearTimeout(publishTimer);
  publishTimer = setTimeout(pump, pace.readUntil - Date.now() + 50);
}
// The user's "read it, next" button.
export function publishNow() { pace.readUntil = 0; publish(true); }

function publishOne(r) {
  const turnNo = q1('SELECT count(*) n FROM messages WHERE chat_id=? AND sender=? AND dm IS NULL', r.chat, r.agent).n + 1;
  const stale = !!q1(`SELECT 1 FROM messages WHERE chat_id=? AND kind='user' AND dm IS NULL AND id>? LIMIT 1`, r.chat, r.basedOn);
  // The name first: setNick saves the state itself, and the notes below save the state read after it.
  if (r.nick) {
    const was = nickOf(r.agent, r.chat), why = setNick(r.chat, r.agent, r.nick);
    logDecision('nick', r.agent, { detail: { nick: r.nick, was, refused: why } });
    if (why) tell(r.agent, { kind: 'note', chat: r.chat, summary: `Your name "${r.nick}" was not taken: ${why}.` });
    else if (was !== r.nick) note(tx(was ? '🏷 @{a} 把名字从「{was}」改成「{nick}」' : '🏷 @{a} 给自己取名「{nick}」', { a: atOf(r.agent), was, nick: r.nick }), r.chat);
  }
  // The reply's [NOTE] lines update the discussion's notes; the message records what changed.
  const st = chatState(r.chat);
  const changed = r.notes?.length ? applyNotes(st.notes ??= [], r.notes, { by: r.agent }) : [];
  // A game reply may be only private messages (no public text): m is then the last of them.
  const base = { chat_id: r.chat, sender: r.agent, kind: 'agent', based_on: r.basedOn, latency_ms: r.ms, model: r.model, mode: chatMode(r.chat).effective,
    nick: nickOf(r.agent, r.chat) };
  const pub = r.text || r.files?.length || !r.dms?.length ? insertMsg({ ...base, text: r.text, files: r.files, turn_no: turnNo, stale, role: r.role, stance: r.stance,
    seat: r.seat, note_ops: changed.length ? JSON.stringify(changed) : null }) : null;
  let m = pub;
  for (const d of r.dms || []) m = insertMsg({ ...base, text: d.text, dm: d.to });
  if (changed.length) {
    for (const x of st.notes) if (changed.some(o => o.n === x.n && o.op !== 'drop')) x.msg = m.id;
    saveState(r.chat, st);
  }
  for (const cmd of r.jobs || []) startJob(r.agent, r.chat, cmd, m.id);
  for (const t of r.todo || []) startTask(r.agent, r.chat, t, m.id);
  if (pub && r.stance && r.role !== 'devil' && r.role !== 'summary') checkShift(pub);
  if (r.role === 'verdict') finishDebate(r.chat);
  run('UPDATE agent_sessions SET turns=turns+1 WHERE chat_id=? AND agent=?', r.chat, r.agent);
  logDecision('publish', r.agent, { based_on: r.basedOn, message_id: m.id, latency_ms: r.ms,
    detail: { stale, turn_no: turnNo, waited_ms: Date.now() - r.done } });
  // After the wrap-up nobody's hand goes up again, so the round ends quietly until the user posts.
  if (r.chat === chatId && !wrapped() && rules(chatId).flow === 'free' && r.role !== 'verdict') {
    if (S.scheduler === 'broadcast') for (const n of NAMES) { if (n !== r.agent) raise(n, 1, 'broadcast'); }
    if (r.hand) raise(r.agent, 1.5, '[HAND]');
    // The consensus has to answer the devil's advocate (in jev mode, only those with something new).
    if (r.role === 'devil') for (const n of NAMES) if (n !== r.agent) raise(n, 1.5, 'answer the devil');
    for (const n of mentions(r.text)) if (n !== r.agent) raise(n, 2, `@ by ${r.agent}`);
    checkConvergence(); // after raising hands: someone just @mentioned hasn't had their say yet
    assess();           // jev mode: who has something new to add now?
    maybeOutsider('watchdog');
  }
  return m;
}

// ---------- moderator: did a stance change, and why? ----------
// Compared with the member's previous own stance in this discussion (devil's advocate turns don't count).
async function checkShift(m) {
  const prev = q1(`SELECT id, stance FROM messages WHERE chat_id=? AND sender=? AND id<? AND stance IS NOT NULL
    AND coalesce(role,'') NOT IN ('devil','summary') ORDER BY id DESC LIMIT 1`, m.chat_id, m.sender, m.id);
  const before = prev && JSON.parse(prev.stance), after = JSON.parse(m.stance);
  if (!before || before.t === after.t) return;
  const from = q1(`SELECT coalesce(max(id),0) m FROM messages WHERE chat_id=? AND kind='user' AND id<?`, m.chat_id, prev.id).m;
  const msgs = q(`SELECT * FROM messages WHERE chat_id=? AND id>=? AND id<=? AND ${TALK} ORDER BY id`, m.chat_id, from, m.id)
    .slice(-30).map(x => ({ ...x, text: withStance(x) }));
  const r = await stanceShift(msgs, m.sender, before, after);
  if (r.error) return logDecision('stance-error', m.sender, { message_id: m.id, detail: r });
  run('UPDATE messages SET stance=? WHERE id=?', JSON.stringify({ ...after, changed: r.changed, evidence: r.evidence }), m.id);
  logDecision('stance', m.sender, { score: r.changed, message_id: m.id, latency_ms: r.ms, detail: { before, after, ...r } });
  sendState();
}
// Each member's latest stance in the current discussion, with its previous own stance (for "changed").
export function stances() {
  const out = {};
  for (const r of q(`SELECT id, sender, role, stance FROM messages WHERE chat_id=? AND kind='agent' AND stance IS NOT NULL ORDER BY id`, chatId)) {
    const o = out[r.sender];
    out[r.sender] = { ...JSON.parse(r.stance), id: r.id, role: r.role, prev: o && o.role !== 'devil' ? { t: o.t, c: o.c } : o?.prev };
  }
  return memberOrder().filter(n => out[n]).map(n => ({ name: n, ...out[n] }));
}

// ---------- moderator: stop when views have converged ----------
async function checkConvergence() {
  // Not while a member's background job or task is still running: its result may change the conclusion.
  if (!rules(chatId).moderated || running(chatId)) return;
  // One judgment at a time (a PASS and a publish used to start two paid calls on the same messages): asked again after.
  if (jev.judging) return void (jev.judgeAgain = true);
  const round = lastUserId(chatId);
  const msgs = q(`SELECT id, sender, kind, text, role, stance FROM messages WHERE chat_id=? AND id>=? AND ${TALK} ORDER BY id`, chatId, round)
    .map(m => ({ ...m, text: withStance(m) }));
  // Only judge once everyone woken this round has weighed in: a slow agent still thinking, queued, or waiting
  // for a free slot may yet disagree. (Agents that passed or failed are idle without a hand, so they don't block.)
  // After a devil's advocate, everyone still busy gets to answer first.
  const isBusy = a => rt[a].status === 'thinking' || rt[a].hand || inQueue(a);
  const devilOpen = msgs.at(-1)?.role === 'devil' || NAMES.some(n => rt[n].role === 'devil' && rt[n].status === 'thinking')
    || NAMES.some(n => rt[n].hand?.why === 'devil') || ready.some(r => r.role === 'devil');
  const pending = a => S.enabled[a] && isBusy(a) && (devilOpen || !msgs.some(m => m.sender === a));
  if ((!S.autoStop && !S.circlePause) || !round || !msgs.some(m => m.kind === 'agent') || NAMES.some(pending)) return;
  if (NAMES.some(n => rt[n].hand?.why === 'devil' || (rt[n].role === 'devil' && rt[n].status === 'thinking'))) return;
  jev.judging = true; sendState();
  const j = await judge(msgs).catch(e => ({ error: e.message }));
  jev.judging = false;
  if (jev.judgeAgain) { jev.judgeAgain = false; if (!wrapped()) return checkConvergence(); }
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
    jev.circledAt = round; setPaused(true, true);
    lowerAll();
    logDecision('circling', null, { score: j.circling, message_id: mod.msgId, detail: j });
    note(tx('🧭 讨论在原地打转（{p}）：同样的论点在来回重复，没有新进展。已暂停，请你定方向：补充信息或约束、@某人回答一个具体问题，或者点“继续”。', { p: pc(j.circling) }));
    maybeOutsider('circling'); // its report resumes the discussion if the user hasn't yet
    return pump();
  }
  if (!stop) return pump();

  // Agreed too easily on a judgment call: before wrapping up, someone argues the other side (once per round).
  if (S.devil && j.debatable >= 0.6 && j.challenged < 0.4 && jev.devilAt !== round) {
    jev.devilAt = round;
    lowerAll();
    // The quietest member this round takes the opposing side; ties at random.
    const devil = NAMES.filter(n => S.enabled[n]).map(n => [n, turnsSinceUser(n), Math.random()])
      .sort((x, y) => x[1] - y[1] || x[2] - y[2])[0][0];
    rt[devil].hand = { r: 100, since: Date.now(), why: 'devil' };
    logDecision('devil', devil, { score: j.debatable, message_id: mod.msgId, detail: j });
    note(tx('🧭 大家很快就达成了一致（收敛度 {p}，几乎没人反对），但这是见仁见智的问题。收尾前请 @{a} 唱反调：站到对立面，给出最有力的反驳。',
      { p: pc(j.convergence), a: atOf(devil) }));
    return pump();
  }
  setWrapRound(round);
  lowerAll();
  // The member most engaged in this round writes the summary; ties go to whoever has summarized least, then random.
  const summaries = a => q1(`SELECT count(*) n FROM decisions WHERE chat_id=? AND event='converged' AND agent=?`, chatId, a).n;
  const writer = NAMES.filter(n => S.enabled[n]).map(n => [n, turnsSinceUser(n), summaries(n), Math.random()])
    .sort((x, y) => y[1] - x[1] || x[2] - y[2] || x[3] - y[3])[0][0];
  rt[writer].hand = { r: 100, since: Date.now(), why: 'summary' };
  logDecision('converged', writer, { score: j.convergence, message_id: mod.msgId, detail: j });
  note(tx('🧭 观点已收敛（收敛度 {p}%，重复度 {s}）。请 @{a} 总结，本轮到此结束；发新消息可继续讨论。',
    { p: Math.round(j.convergence * 100), s: j.stalling.toFixed(2), a: atOf(writer) }));
  pump();
}

// ---------- what the user does to the room ----------
// files: already validated (this discussion's uploads only).
export function userSends(text, reply_to, files) {
  pace.typingAt = 0; mod = null;
  endCirclePause(); // the user set a direction
  // An untitled discussion is named after its first question.
  const c = q1('SELECT title FROM chats WHERE id=?', chatId);
  if (/^(讨论|Discussion) \d+$/.test(c.title) && !q1(`SELECT 1 FROM messages WHERE chat_id=? AND kind='user'`, chatId))
    run('UPDATE chats SET title=? WHERE id=?', (text || files[0].name).replace(/\s+/g, ' ').slice(0, 30), chatId);
  if (userPlays(chatId) && rules(chatId).flow === 'game') return userPlay(text, files, reply_to);
  const m = insertMsg({ chat_id: chatId, sender: 'user', kind: 'user', text, reply_to: reply_to || null, files });
  logDecision('user', null, { message_id: m.id, detail: { mentions: mentions(text), reply_to: reply_to || null } });
  const cm = chatMode(chatId);
  if (classifying.has(chatId) || opening?.chat === chatId) return;          // the pending classification / hold wakes the room
  if (cm.mode === 'auto' && !cm.auto) return void classifyChat(chatId, m); // first question of an Auto discussion
  wake(m);
}
// Stop ends the round at once, leaving the server idle: thinking turns are cancelled, written replies not yet
// published are dropped, read-aloud stops. The discussion keeps its place (debate slot, relay baton, notes): the
// user's next message carries on from there.
export function stopAll() {
  const cancelled = NAMES.filter(thinking);
  for (const n of NAMES) { rt[n].hand = null; rt[n].abort?.abort(); }
  memo.abort?.abort();
  const dropped = dropReady(r => r.chat === chatId);
  dropHeld();
  // a dropped debate reply had already moved the debate on: its slot is played again
  rewindDebate(chatId, dropped.map(r => r.slot).filter(x => x != null));
  setPaused(false);
  setWrapRound(lastUserId(chatId)); // the round is over: nothing raises hands until the user writes again
  pace.readUntil = pace.speakingAt = 0;
  if (opening) openNow(opening.chat, false); // nothing starts after a stop
  logDecision('stop', null, { detail: { cancelled, dropped: dropped.map(r => r.agent) } });
}
export function switchTo(id) {
  setCurrent(id);
  lowerAll();
  pace.readUntil = 0; mod = null; archiveSoon(id);
  resumeGame(id);
  resync();
}
// The user overrides (or returns to) Auto at any time; it applies from the next turn.
export function setChatMode(id, mode) {
  run('UPDATE chats SET mode=? WHERE id=?', mode, id);
  logDecision('mode', null, { detail: { source: 'user', mode } });
  const cm = chatMode(id);
  if (opening?.chat === id) openNow(id); // the user chose during the hold: start now, in that mode
  if (id === chatId) note(mode === 'auto'
    ? (cm.auto ? tx('🧭 讨论模式改回自动：{mode}。', { mode: tx(MODES[cm.auto].label) }) : tx('🧭 讨论模式改回自动，Jev 会根据问题判断。'))
    : tx('🧭 讨论模式改为：{mode}（你指定），从下一轮发言开始生效。', { mode: tx(MODES[mode].label) }));
  if (mode === 'auto' && !cm.auto) classifyChat(id);
}
// A discussion was deleted: its queued replies go with it.
export function forgetChat(id) { dropReady(r => r.chat === id); }
