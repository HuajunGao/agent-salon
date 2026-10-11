// ---------- training window: every member works alone on the same goal, a frozen referee keeps score ----------
// In chat a turn ends the moment a reply is posted, so members rarely do long work; alone they build better bots (kore:
// independent bots beat the group-built ones). The user opens a window: goal, minutes, a referee from
// _shared/referees/<name>/referee.py. Each enabled member gets a background task session (its own CLI and model, in its
// own workspace, no chat) with the user's goal verbatim, writing one entry file. The referee directory is copied to
// _arena/<id>/referee, owned by the server (root), so nobody can move the goalposts during the window. Every `every`
// minutes the server probes each changed entry with it and posts the win rate (system-measured, not self-reported);
// at time-up (or the user's button) the sessions are stopped and the referee's round robin gives the standings.
// A session that ends early, or dies with a restart, is resumed from its CLI session id while time is left.
// Referee contract: `referee.py probe <bot> <outdir>` / `referee.py rank <outdir> name=<bot> ...`, last stdout line
// JSON {rate, games, replay?} / {standings: [{name, rate, games}], replays?: [...]}, replay files in outdir.
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnJob } from './agents.mjs';
import { q } from './db.mjs';
import { WORK, SHARED, PUBLIC, wsOf, own } from './workspace.mjs';
import { S, NAMES, memberConfigs, atOf, memberAt, tx, replyLang, wURL, fileCapable } from './config.mjs';
import { chatId, chatState, saveState, logDecision, note, describe } from './chats.mjs';
import { raise, tell, pump } from './runtime.mjs';
import { startTask, killJob, tasks, hasTask } from './jobs.mjs';
import { sendState } from './sse.mjs';

const ARENA = join(WORK, '_arena'), REFEREES = join(SHARED, 'referees');
export const PY = process.env.ARENA_PYTHON || (existsSync(join(SHARED, '.venv/bin/python')) ? join(SHARED, '.venv/bin/python')
  : process.platform === 'win32' ? 'python' : 'python3');
const REF_MS = 2 * 3600e3, RESUME_MIN_MS = 3 * 60e3; // ponytail: one referee timeout for probe and rank
export const referees = () => (existsSync(REFEREES) ? readdirSync(REFEREES).filter(d => existsSync(join(REFEREES, d, 'referee.py'))) : []);
const pct = x => `${Math.round(x * 100)}%`;
const localISO = t => new Date(t - new Date(t).getTimezoneOffset() * 60e3).toISOString(); // the server's local time
// The open window: its discussion's chats.state.arena plus the chat id (restored at start, so a restart resumes it).
export let arena = null, probing = null; // probing: the member being measured
let ranking = null;                       // the referee's round robin: {kill} while it runs
for (const c of q(`SELECT id, state FROM chats WHERE state LIKE '%"arena"%'`)) {
  const x = JSON.parse(c.state).arena;
  if (x && x.phase !== 'done') arena = { ...x, chat: c.id };
}
const saveArena = (A = arena) => { const st = chatState(A.chat); st.arena = (({ chat, ...x }) => x)(A); saveState(A.chat, st); };
const entryOf = (A, a) => join(wsOf(a), `arena_${A.id}`, 'bot.py');
export const arenaURL = (A, f = '') => `${wURL()}arena/${A.id}/${f}`;
// A window session's job, which resumes itself after a restart (not reported as interrupted).
export const arenaJob = id => !!arena && Object.values(arena.members).some(m => m.job === id);

export function startArena(chat, { goal, minutes, every, referee }) {
  goal = String(goal || '').trim(); minutes = +minutes; every = +every || 10;
  if (arena) throw new Error('已有一个训练窗口在进行');
  if (!S.exec) throw new Error('先在讨论设置里打开“允许执行代码”');
  if (!goal) throw new Error('写一下训练目标');
  if (!(minutes > 0 && minutes <= 600 && every > 0)) throw new Error('时长要在 0–600 分钟之间');
  if (!referees().includes(referee)) throw new Error(tx('没有这个裁判：{path}', { path: `${REFEREES}/<${tx('名字')}>/referee.py` }));
  const who = NAMES.filter(a => S.enabled[a] && fileCapable(a) && !hasTask(a));
  if (!who.length) throw new Error('没有能参加的成员（要启用、能操作文件、且没有后台任务在跑）');
  const now = Date.now(), id = `W${localISO(now).slice(2, 16).replace(/\D/g, '')}`;
  const A = { chat, id, goal, minutes, every, referee, from: now, until: now + minutes * 60e3, lastProbe: now, phase: 'work',
    dir: join(ARENA, id, 'referee'), out: join(PUBLIC, 'arena', id), members: Object.fromEntries(who.map(a => [a, {}])) };
  // the frozen copy stays the server's (read-only for the members); outputs and entries are theirs
  cpSync(join(REFEREES, referee), A.dir, { recursive: true, filter: f => !f.includes('__pycache__') });
  mkdirSync(A.out, { recursive: true }); own(dirname(A.out)); own(A.out);
  for (const a of who) { mkdirSync(dirname(entryOf(A, a)), { recursive: true }); own(dirname(entryOf(A, a))); }
  arena = A; saveArena();
  logDecision('arena-start', null, { detail: { id, goal, minutes, every, referee, members: who } });
  note(tx('🏁 训练窗口 {id} 开始：{who} 各自独立做 {m} 分钟，裁判 {ref}（已冻结）。每 {every} 分钟自动评测一次有改动的 bot，到点跑循环赛。',
    { id, who: who.map(a => `@${atOf(a)}`).join(' '), m: minutes, ref: referee, every }) + `\n\n${tx('目标：')}${goal}`, chat);
  arenaTick();
}
// The user's button: end the work now, or (while ranking) stop the round robin.
export function stopArena() { if (arena?.phase === 'work') endWork('user'); else ranking?.kill?.(); }

function arenaPrompt(A, a, resumed) {
  const left = Math.round((A.until - Date.now()) / 60e3), until = localISO(A.until).slice(11, 16);
  if (resumed) return `The training window is still open: ${left} minutes left (until ${until}). Your session
was interrupted; carry on from where you were, same goal and rules. Keep a working version in ${entryOf(A, a)}.`;
  return `You are ${describe(a)}, a member of a group chat on the user's machine. The user opened a timed training window:
for ${A.minutes} minutes every member works alone, in their own workspace, on the same goal. This is not a chat turn:
nobody answers questions, and you don't see the chat.

The user's goal, verbatim:

${A.goal}

Your entry is the single file ${entryOf(A, a)}: keep a working version there at all times, the server copies whatever
is there. Every ${A.every} minutes it measures a changed entry with the frozen referee and posts the result to the chat; at
the end it runs a round robin of all members' entries with the same referee and posts the standings.
The referee is ${A.dir} (read-only; read referee.py for the rules and how games are scored). You can run it yourself:
\`${PY} ${join(A.dir, 'referee.py')} probe <your bot> <an output directory of yours>\`. Python: ${PY}.
Earlier code and results in the shared repo ${SHARED} are resources, not the answer: start from them, rewrite from scratch
or search the web, whichever you judge best. Work in ${wsOf(a)}.
You have until ${until} (${left} minutes); if your session ends early the server resumes it, so keep notes of
what you tried in your workspace. At the end, reply in ${replyLang()} with a short summary: the routes you considered and
which you took, what you measured, and what is in your entry.`;
}

// Every second (server.mjs): starts or resumes sessions, probes on schedule, ends the work at time-up, ranks.
export function arenaTick() {
  const A = arena;
  if (!A) return;
  if (A.phase === 'work') {
    if (Date.now() >= A.until) return endWork('time');
    for (const [a, m] of Object.entries(A.members)) if (!m.out && !tasks.has(m.job) && memberConfigs[a]) arenaWork(A, a);
    if (!probing && Date.now() - A.lastProbe >= A.every * 60e3) probeAll(A);
  } else if (A.phase === 'ranking' && !ranking && !Object.values(A.members).some(m => tasks.has(m.job))) rankArena(A);
}

function arenaWork(A, a) {
  const m = A.members[a], left = A.until - Date.now();
  if (m.sessions && left < RESUME_MIN_MS) return; // not worth resuming
  const id = startTask(a, A.chat, { desc: `${tx('训练窗口')} ${A.id}${tx('：')}${A.goal}` }, null, {
    prompt: arenaPrompt(A, a, !!m.sid), sid: m.sid, totalMs: left,
    onSid: sid => { m.sid = sid; saveArena(A); },
    onEnd: (status, res) => {
      m.job = null;
      if (res.text) m.summary = res.text.slice(-3000);
      // three quick failures in a row and the member is out of this window (the second one tries a fresh session)
      m.fails = res.error && status !== 'stopped' && res.ms < 120e3 ? (m.fails || 0) + 1 : 0;
      if (m.fails === 2) m.sid = null;
      if (m.fails >= 3) { m.out = true; note(tx('⚠ @{a} 的训练会话连续失败，退出本轮：{err}', { a: memberAt(a), err: res.error }), A.chat); }
      saveArena(A);
      logDecision('arena-session', a, { latency_ms: res.ms, detail: { id: A.id, status, error: res.error || null, fails: m.fails } });
    },
  });
  if (id) { m.job = id; m.sessions = (m.sessions || 0) + 1; saveArena(A); }
}

// Runs the frozen referee as the agent user (the bots are the members' code). Resolves its last JSON line, or {error}.
function runReferee(A, args) {
  const lf = join(ARENA, A.id, `${args[0]}-${Date.now()}.log`), fd = openSync(lf, 'w');
  const p = spawnJob([PY, join(A.dir, 'referee.py'), ...args], { cwd: A.out, out: fd });
  closeSync(fd);
  const kill = () => { try { process.kill(process.platform === 'win32' ? p.pid : -p.pid, 'SIGKILL'); } catch {} };
  const timer = setTimeout(kill, REF_MS);
  return new Promise(res => {
    const end = err => {
      clearTimeout(timer);
      const log = readFileSync(lf, 'utf8'), line = log.trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
      try { if (!err && line) return res(JSON.parse(line)); } catch {}
      res({ error: (err || log.trim().split('\n').slice(-5).join('\n') || 'no output').slice(-800) });
    };
    p.on('error', e => end(e.message));
    p.on('exit', (code, sig) => end(sig ? `killed (${sig})` : ''));
    if (args[0] === 'rank') ranking = { kill };
  });
}

// Measures every entry that changed since its last probe, one at a time, and posts the change.
async function probeAll(A) {
  A.lastProbe = Date.now(); saveArena(A);
  for (const a of Object.keys(A.members)) {
    if (arena !== A || A.phase !== 'work') break;
    const f = entryOf(A, a), m = A.members[a];
    if (!existsSync(f)) continue;
    const src = readFileSync(f), hash = createHash('sha1').update(src).digest('hex').slice(0, 10);
    if (hash === m.hash) continue;
    const n = (m.probes || 0) + 1, bot = join(A.out, `${a}-${n}.py`);
    writeFileSync(bot, src); own(bot);
    probing = a; sendState();
    const r = await runReferee(A, ['probe', bot, A.out]);
    probing = null;
    Object.assign(m, { hash, probes: n });
    logDecision('arena-probe', a, { detail: { id: A.id, n, hash, rate: r.rate ?? null, games: r.games ?? null, error: r.error || null } });
    if (r.error || typeof r.rate !== 'number') note(`${tx('⚠ @{a} 的第 {n} 版 bot 评测失败：', { a: memberAt(a), n })}\n\`\`\`\n${r.error || JSON.stringify(r)}\n\`\`\``, A.chat);
    else {
      const was = m.rate; m.rate = r.rate;
      note(`${was == null ? '📊' : r.rate > was ? '📈' : r.rate < was ? '📉' : '➖'} ${tx('@{a} 第 {n} 版：', { a: memberAt(a), n })}`
        + `${was == null ? '' : `${pct(was)} → `}**${pct(r.rate)}**${tx('（{g} 局对基线）', { g: r.games })}`
        + `${r.replay ? ` · [${tx('回放')}](${arenaURL(A, r.replay)})` : ''} · [${tx('代码')}](${arenaURL(A, `${a}-${n}.py`)})`, A.chat);
    }
    saveArena(A); sendState();
  }
  if (probing === null) sendState();
}

function endWork(why) {
  const A = arena;
  A.phase = 'ranking'; A.ended = Date.now(); saveArena(A);
  for (const m of Object.values(A.members)) if (tasks.has(m.job)) killJob(m.job, 'stopped');
  logDecision('arena-end-work', null, { detail: { id: A.id, why } });
  note(tx(why === 'user' ? '⏱ 训练窗口 {id}被你提前结束：所有人停手，开始循环赛。' : '⏱ 训练窗口 {id}到点了：所有人停手，开始循环赛。', { id: A.id }), A.chat);
  sendState();
}

async function rankArena(A) {
  const names = Object.keys(A.members).filter(a => existsSync(entryOf(A, a)));
  for (const a of names) { const f = join(A.out, `${a}-final.py`); writeFileSync(f, readFileSync(entryOf(A, a))); own(f); }
  ranking = true;
  const r = names.length < 2 ? { error: tx('只有 {n} 份参赛 bot，不够打循环赛', { n: names.length }) }
    : await runReferee(A, ['rank', A.out, ...names.map(a => `${a}=${join(A.out, `${a}-final.py`)}`)]);
  ranking = null;
  const ok = Array.isArray(r.standings);
  A.phase = 'done'; A.result = ok ? { standings: r.standings, replays: r.replays || [] } : { error: r.error || JSON.stringify(r) };
  saveArena(A);
  if (arena === A) arena = null;
  logDecision('arena-rank', null, { detail: { id: A.id, ...A.result } });
  const who = n => (memberConfigs[n] ? `@${atOf(n)}` : n);
  const table = ok ? `${tx('| 名次 | 成员 | 胜率 | 局数 |')}\n|---|---|---|---|\n`
    + r.standings.map((s, i) => `| ${i + 1} | ${who(s.name)} | ${pct(s.rate)} | ${s.games} |`).join('\n')
    + (A.result.replays.length ? `\n\n${tx('回放：')}${A.result.replays.map(f => `[${f.replace(/\.html$/, '')}](${arenaURL(A, f)})`).join(' · ')}` : '') : '';
  note(ok ? `${tx('🏆 训练窗口 {id} 循环赛结果（裁判 {ref}）：', { id: A.id, ref: A.referee })}\n\n${table}`
    : tx('⚠ 训练窗口 {id} 的循环赛没有结果：{err}', { id: A.id, err: A.result.error }), A.chat);
  // The meeting: everyone is woken with the standings and its own session's last summary.
  const plain = ok ? r.standings.map((s, i) => `${i + 1}. ${s.name} ${pct(s.rate)} (${s.games} games)`).join('\n') : `no result: ${A.result.error}`;
  for (const [a, m] of Object.entries(A.members)) {
    if (!memberConfigs[a]) continue;
    tell(a, { kind: 'arena', chat: A.chat, summary: `The training window ${A.id} ("${A.goal}") is over. `
      + `Round robin with the frozen referee:\n${plain}\nEntries and replays: ${A.out} (${arenaURL(A)}). Your entry: ${entryOf(A, a)}.`
      + (m.summary ? `\nYour window session's last summary:\n${m.summary}` : '')
      + `\nTell the others what you tried and what you measured, and what the next round should try.` });
    if (A.chat === chatId) raise(a, 3, 'job');
  }
  pump(); sendState();
}
