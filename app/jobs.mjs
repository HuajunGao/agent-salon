// ---------- background jobs and tasks ----------
// A member's [JOB] line runs a command as its own process (setsid), so it outlives the turn. A [TASK] line starts a
// background coding session: the member's own CLI and model, a fresh session, no chat pacing and longer limits, in
// the member's workspace or, for [TASK shared], in a git worktree of the shared repo (branch task/T<id>) that is
// merged back when it ends. Either way the chat hears about the end and the member is woken with the result.
// A server restart stops what is running (systemd kills the service's cgroup): reported as interrupted at the next start.
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, fchownSync } from 'node:fs';
import { join } from 'node:path';
import { runTurn, spawnJob } from './agents.mjs';
import { q, q1, run } from './db.mjs';
import { DATA, SHARED, TASKS, RUNAS, wsOf, jobLog, git, commitShared } from './workspace.mjs';
import { S, memberConfigs, tx, atOf, memberAt, replyLang, wURL, fileCapable } from './config.mjs';
import { chatId, chatExists, logDecision, note, fmt, describe, TALK } from './chats.mjs';
import { rt, raise, tell, pump } from './runtime.mjs';
import { sendState, sendStateSoon } from './sse.mjs';

const JOB_MAX = 3, JOB_MS = 3 * 3600e3; // ponytail: global caps, per-member limits if one member hogs the slots
export const TASK_MS = 60 * 60e3; const TASK_IDLE_MS = 15 * 60e3; // tasks: one per member at a time, so as many as there are members
const procs = new Map(); // job id -> child process
export const tasks = new Map(); // task id -> {agent, abort, live}
export const hasTask = a => [...tasks.values()].some(t => t.agent === a);
export const taskLive = id => tasks.get(id)?.live;
const tag = (id, kind) => `${kind === 'task' ? 'T' : 'J'}${id}`;
export const dur = ms => (ms < 60e3 ? tx('{s} 秒', { s: Math.round(ms / 1000) }) : tx('{m} 分 {s} 秒', { m: Math.floor(ms / 60e3), s: Math.round(ms % 60e3 / 1000) }));
export const running = chat => !!q1(`SELECT 1 FROM jobs WHERE status='running' AND chat_id=?`, chat);

// Worktree cleanup. A task's worktree is removed as soon as the task ends (its changes are committed to its branch
// first); the branch is deleted once merged. Unmerged branches (conflict, failed or stopped task) stay for the member
// to merge by hand, and are deleted after a week. At start, worktrees of interrupted tasks are committed and removed.
const BRANCH_DAYS = 7;
function dropWorktree(a, id, dir, status) {
  commitShared(a, `${a}: task T${id} (${status})`, dir);
  git(a, SHARED, 'worktree', 'remove', '--force', dir);
}
export function cleanupTasks() {
  if (!RUNAS) return;
  git('server', SHARED, 'worktree', 'prune');
  for (const b of git('server', SHARED, 'branch', '--merged', 'HEAD', '--list', 'task/*', '--format=%(refname:short)').stdout.split('\n').filter(Boolean))
    if (!q1(`SELECT 1 FROM jobs WHERE status='running' AND branch=?`, b)) git('server', SHARED, 'branch', '-d', b);
  const old = Date.now() / 1000 - BRANCH_DAYS * 86400;
  for (const line of git('server', SHARED, 'for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads/task/').stdout.split('\n').filter(Boolean)) {
    const [b, at] = line.split(' ');
    if (+at < old && !q1(`SELECT 1 FROM jobs WHERE status='running' AND branch=?`, b)) {
      git('server', SHARED, 'branch', '-D', b); logDecision('task-branch-expired', null, { detail: { branch: b } });
    }
  }
}
// At start: what was running died with the previous process. keep(j): the job's owner resumes it itself (training window).
export function recoverJobs(keep = () => false) {
  for (const j of q(`SELECT * FROM jobs WHERE status='running'`)) {
    run(`UPDATE jobs SET status='interrupted', ended_at=CURRENT_TIMESTAMP WHERE id=?`, j.id);
    if (keep(j)) continue;
    if (j.branch && RUNAS && existsSync(join(TASKS, `T${j.id}`))) dropWorktree(j.agent, j.id, join(TASKS, `T${j.id}`), 'interrupted');
    if (!chatExists(j.chat_id)) continue;
    note(tx('⚠ 后台任务 {tag}（@{a}）因服务器重启中断', { tag: tag(j.id, j.kind), a: memberAt(j.agent) })
      + (j.branch ? tx('，改动保留在分支 {b}', { b: j.branch }) : '') + `${tx('：')}\`${j.cmd}\``, j.chat_id);
    // The member hears about it too (moderator notes never reach the members), and in the current discussion is woken.
    if (!memberConfigs[j.agent]) continue;
    tell(j.agent, { kind: j.kind, id: j.id, cmd: j.cmd, chat: j.chat_id, status: 'interrupted', why: 'the server restarted',
      ...(j.branch && { branch: j.branch, merge: 'kept' }) });
    if (j.chat_id === chatId) raise(j.agent, 3, 'job');
  }
  cleanupTasks();
}

export function startJob(a, chat, cmd, msgId) {
  if (procs.size >= JOB_MAX) return jobDone(a, chat, { kind: 'job', cmd, status: 'rejected', why: tx('已有 {n} 个后台任务在跑', { n: JOB_MAX }) });
  const id = Number(run(`INSERT INTO jobs(chat_id, agent, cmd, msg_id, status) VALUES(?,?,?,?,'running')`, chat, a, cmd, msgId).lastInsertRowid);
  const fd = openSync(jobLog(id), 'w');
  if (RUNAS) fchownSync(fd, RUNAS.uid, RUNAS.gid);
  const p = spawnJob(cmd, { cwd: wsOf(a), out: fd }), t0 = Date.now();
  closeSync(fd);
  procs.set(id, p);
  const timer = setTimeout(() => killJob(id, 'timeout'), JOB_MS);
  let ended = false;
  const end = (code, error) => {
    if (ended) return; ended = true;
    clearTimeout(timer); procs.delete(id);
    const status = p.why || (code === 0 ? 'done' : 'failed');
    run('UPDATE jobs SET status=?, code=?, ended_at=CURRENT_TIMESTAMP WHERE id=?', status, code ?? null, id);
    logDecision('job-end', a, { message_id: msgId, latency_ms: Date.now() - t0, detail: { job: id, status, code, error } });
    commitShared(a, `${a}: job J${id} ${status}: ${cmd}`.slice(0, 200));
    jobDone(a, chat, { kind: 'job', id, cmd, status, code, ms: Date.now() - t0, why: error, tail: readFileSync(jobLog(id), 'utf8').slice(-1500) });
  };
  p.on('error', e => end(null, e.message));
  p.on('exit', code => end(code));
  logDecision('job-start', a, { message_id: msgId, detail: { job: id, cmd } });
  note(`${tx('▶ @{a} 启动后台任务 J{id}：', { a: atOf(a), id })}\`${cmd}\``, chat);
  sendState();
}

// o (training window sessions): prompt and sid replace the task prompt and a fresh session, totalMs the time limit,
// onSid(sid) / onEnd(status, res) replace the chat notes and the member's wake-up. Returns the task id, null if rejected.
export function startTask(a, chat, { desc, shared }, msgId, o = {}) {
  const harness = memberConfigs[a].harness;
  const reject = why => (o.onEnd ? null : jobDone(a, chat, { kind: 'task', cmd: desc, status: 'rejected', why }));
  if (!fileCapable(a)) return reject(tx('这位成员不能操作文件'));
  if (hasTask(a)) return reject(tx('你已有一个后台写代码任务在跑'));
  const id = Number(run(`INSERT INTO jobs(chat_id, agent, cmd, msg_id, status, kind) VALUES(?,?,?,?,'running','task')`, chat, a, desc, msgId).lastInsertRowid);
  const branch = shared ? `task/T${id}` : null, cwd = shared ? join(TASKS, `T${id}`) : wsOf(a);
  if (shared) {
    // The worktree starts from the shared repo as it is now (committed first; a fresh repo gets an empty first commit).
    commitShared(a, `${a}: before task T${id}`);
    if (git(a, SHARED, 'rev-parse', '--verify', '-q', 'HEAD').status) git(a, SHARED, 'commit', '-q', '--allow-empty', '-m', 'start');
    const w = git(a, SHARED, 'worktree', 'add', '-q', '-b', branch, cwd, 'HEAD');
    if (w.status) {
      run(`UPDATE jobs SET status='failed', ended_at=CURRENT_TIMESTAMP WHERE id=?`, id);
      return jobDone(a, chat, { kind: 'task', id, cmd: desc, status: 'failed', why: tx('建 worktree 失败：{err}', { err: w.stderr.trim().slice(0, 200) }) });
    }
    run('UPDATE jobs SET branch=? WHERE id=?', branch, id);
  }
  const model = S.models[a], t = { agent: a, abort: new AbortController(), live: '' }, t0 = Date.now();
  tasks.set(id, t);
  logDecision('task-start', a, { message_id: msgId, detail: { task: id, shared, desc } });
  if (!o.onEnd) note(tx('▶ @{a} 启动后台写代码任务 T{id}（{where}）：{desc}',
    { a: atOf(a), id, where: shared ? tx('共享仓分支 {b}', { b: branch }) : tx('自己的工作区'), desc }), chat);
  sendState();
  runTurn(harness, o.prompt || taskPrompt(a, chat, id, desc, cwd, branch, msgId), o.sid || null, {
    cwd, dataDir: DATA, shared: SHARED, model, exec: true, member: { ...memberConfigs[a], model }, onSid: o.onSid,
    onLive: log => { t.live = log; sendStateSoon(); }, signal: t.abort.signal, idleMs: TASK_IDLE_MS, totalMs: o.totalMs || TASK_MS,
  }).catch(e => ({ error: e.message, ms: Date.now() - t0 })).then(res => {
    tasks.delete(id);
    const status = res.error === 'stopped' ? 'stopped' : /timeout/.test(res.error || '') ? 'timeout' : res.error ? 'failed' : 'done';
    writeFileSync(jobLog(id, 'task'), `${t.live}\n\n--- ${status}${res.error ? `: ${res.error}` : ''} ---\n${res.text || ''}\n`);
    let merge = null;
    if (shared) {
      dropWorktree(a, id, cwd, status);
      if (status === 'done') {
        commitShared(a, `${a}: before merging task T${id}`);
        const m = git(a, SHARED, 'merge', '-q', '--no-ff', '-m', `${a}: merge task T${id}: ${desc}`.slice(0, 200), branch);
        if (m.status) { git(a, SHARED, 'merge', '--abort'); merge = 'conflict'; }
        else { git(a, SHARED, 'branch', '-q', '-d', branch); merge = 'merged'; }
      } else merge = 'kept';
    } else commitShared(a, `${a}: task T${id} ${status}`.slice(0, 200));
    run('UPDATE jobs SET status=?, ended_at=CURRENT_TIMESTAMP WHERE id=?', status, id);
    logDecision('task-end', a, { message_id: msgId, latency_ms: res.ms, detail: { task: id, status, error: res.error || null, merge } });
    if (o.onEnd) return (o.onEnd(status, res), sendState());
    jobDone(a, chat, { kind: 'task', id, cmd: desc, status, ms: Date.now() - t0, why: res.error && status === 'failed' ? res.error : '',
      summary: res.text, branch, merge });
  });
  return id;
}
function taskPrompt(a, chat, id, desc, cwd, branch, msgId) {
  const title = q1('SELECT title FROM chats WHERE id=?', chat)?.title || '';
  const recent = q(`SELECT * FROM messages WHERE chat_id=? AND ${TALK} ORDER BY id DESC LIMIT 12`, chat).reverse().map(fmt).join('\n\n');
  return `You are ${describe(a)}, a member of a group chat on the user's machine. In the discussion "${title}" you started
a background task for yourself (#${msgId}, task T${id}):

${desc}

Do it now, on your own: this is not a chat turn, nobody answers questions during it, and the chat goes on without you.
Work in ${cwd}${branch ? `, a git worktree of the shared repo ${SHARED} on branch ${branch}. When you finish, the server
commits your changes and merges the branch into the shared repo; don't merge or push yourself, and keep the changes to
what the task needs so the merge stays clean. Pages you put in public/ appear under ${wURL()} after the merge.` : ` (your own workspace).`}
Python: use ${SHARED}/.venv. You have up to ${TASK_MS / 60e3} minutes; long commands are fine. Test what you build.
When you are done, reply in ${replyLang()} with a short summary: what you changed (files), how you verified it, and what
is left or uncertain. The summary goes back to you in the chat.

Recent messages in the discussion, for context:

${recent}`;
}

export function killJob(id, why) {
  const t = tasks.get(id);
  if (t) return t.abort.abort();
  const p = procs.get(id);
  if (!p) return;
  p.why = why;
  try { process.kill(-p.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 5000);
}
// Tells the chat and wakes the member, whose next turn gets the result (a job's log tail, a task's summary).
const JOB_TEXT = { done: '完成', failed: '失败', stopped: '已被停止', timeout: '超时被停止', rejected: '没有启动' };
const MERGE_TEXT = { merged: '，改动已合并到共享仓', conflict: '，合并有冲突，改动保留在分支 {b}', kept: '，改动保留在分支 {b}' };
function jobDone(a, chat, j) {
  note(`${j.status === 'done' && j.merge !== 'conflict' ? '✅' : '⚠'} `
    + tx(j.kind === 'task' ? '后台写代码任务{tag}（@{a}）{status}' : '后台任务{tag}（@{a}）{status}', { tag: j.id ? ` ${tag(j.id, j.kind)}` : '', a: memberAt(a), status: tx(JOB_TEXT[j.status]) })
    + (j.code ? tx('，退出码 {code}', { code: j.code }) : '') + (j.ms != null ? tx('，用时 {t}', { t: dur(j.ms) }) : '')
    + (j.merge ? tx(MERGE_TEXT[j.merge], { b: j.branch }) : '') + (j.why ? tx('：') + j.why : '') + tx('。'), chat);
  tell(a, { ...j, chat });
  if (chat === chatId && j.status !== 'stopped') raise(a, 3, 'job');
  pump();
}
// The finished jobs and tasks a member hasn't heard about yet, for its next turn in that discussion.
const MERGE_INFO = {
  merged: 'Its changes were merged into the shared repo.',
  conflict: `Merging it into the shared repo conflicted, so nothing was merged: the changes are on branch BRANCH. Merge it in ${SHARED} (git merge BRANCH), resolve the conflicts and commit, or start another task to do that.`,
  kept: `Nothing was merged: the changes so far are on branch BRANCH in ${SHARED} (merge or delete it).`,
};
export function jobReport(a, chat) {
  const r = rt[a], mine = (r.jobs || []).filter(j => j.chat === chat);
  r.jobs = (r.jobs || []).filter(j => j.chat !== chat);
  return mine.map(j => j.kind === 'arena' || j.kind === 'note' ? `\n\n${j.summary}` : `\n\nYour background ${j.kind}${j.id ? ` ${tag(j.id, j.kind)}` : ''} \`${j.cmd}\`: ${j.status}`
    + `${j.code != null ? ` (exit code ${j.code})` : ''}${j.ms != null ? ` after ${dur(j.ms)}` : ''}${j.why ? ` (${j.why})` : ''}.`
    + (j.merge ? ` ${MERGE_INFO[j.merge].replaceAll('BRANCH', j.branch)}` : '')
    + (j.id && existsSync(jobLog(j.id, j.kind)) ? ` Log: ${jobLog(j.id, j.kind)}` : '')
    + (j.summary ? `\nThe task's summary:\n${j.summary.slice(0, 3000)}` : j.tail ? `, last lines:\n${j.tail}` : '')).join('');
}
