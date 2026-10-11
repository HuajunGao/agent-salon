// The filesystem: where data and the members' workspaces live, the OS user the CLIs run as, and the shared git repo.
// Importing this module creates the directories (and, as root with AGENT_USER, hands them to the agent user).
import { readFileSync, appendFileSync, mkdirSync, existsSync, statSync, realpathSync, chownSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAs } from './agents.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
// One instance per person (PROFILE): each has its own DATA_DIR and WORK_DIR, so discussions, memory and workspaces
// never mix. PROFILES ("Alice=:3517,Bob=:3518", a port on the same host or a full URL) lists them all for /who.
export const DATA = resolve(process.env.DATA_DIR || join(ROOT, 'data')), WORK = resolve(process.env.WORK_DIR || join(ROOT, 'workspace'));
// Every discussion is archived as data/discussions/<id>.md plus an index, so agents can look up earlier ones.
export const ARCHIVE = join(DATA, 'discussions'), MEMORY = join(DATA, 'memory.md');
// Files the user attaches: data/uploads/<chat>/<stamp>-<name>, readable by the agents (their paths go into prompts).
export const UPLOADS = join(DATA, 'uploads');
mkdirSync(ARCHIVE, { recursive: true }); mkdirSync(WORK, { recursive: true }); mkdirSync(UPLOADS, { recursive: true });
// AGENT_USER (Linux, server as root): the CLIs run as that user, each in its own workspace it may write and execute in;
// the database stays root-only, the archive and memory are readable. Without it (e.g. Windows) all share workspace/.
export const RUNAS = process.env.AGENT_USER ? runAs(process.env.AGENT_USER) : null;
export const wsOf = a => join(WORK, a);
export const own = f => RUNAS && chownSync(f, RUNAS.uid, RUNAS.gid);
export function ensureWorkspace(a) { mkdirSync(wsOf(a), { recursive: true }); own(wsOf(a)); }
// The members' common project directory (a git repo; handles start with a letter, so no member owns "_shared").
// Its public/ is served at /w/, so what they build can be opened in the browser.
// Background jobs' and tasks' logs live next to it (not in the repo): workspace/_jobs/J<id>.log / T<id>.log;
// [TASK shared] worktrees in workspace/_tasks/T<id> (branch task/T<id>), removed when the task ends.
export const SHARED = join(WORK, '_shared'), PUBLIC = join(SHARED, 'public'), JOBS = join(WORK, '_jobs'), TASKS = join(WORK, '_tasks');
export const jobLog = (id, kind = 'job') => join(JOBS, `${kind === 'task' ? 'T' : 'J'}${id}.log`);
mkdirSync(PUBLIC, { recursive: true }); mkdirSync(JOBS, { recursive: true }); mkdirSync(TASKS, { recursive: true });
// A file the agents wrote, if it really is under WORK (through symlinks: the server runs as root, and an agent could link
// avatar.png to the database or the env file).
const REAL_WORK = realpathSync(WORK);
export const inWork = p => { try { p = realpathSync(p); return p.startsWith(REAL_WORK + sep) && statSync(p).isFile() ? p : null; } catch { return null; } };
export const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/plain', csv: 'text/plain', json: 'text/plain' };
export const extOf = p => p.split('.').pop().toLowerCase();
// A member's avatar: avatar.png / .jpg / .webp / .gif in its workspace (members draw or generate their own), at /avatar/<name>.
export const avatarOf = a => ['png', 'jpg', 'jpeg', 'webp', 'gif'].map(e => inWork(join(wsOf(a), `avatar.${e}`))).find(Boolean);
export const avatarV = a => { const p = avatarOf(a); return p ? Math.round(statSync(p).mtimeMs) : 0; };
export const readMemory = () => (existsSync(MEMORY) ? readFileSync(MEMORY, 'utf8') : '');
// The shared Python environment and caches stay out of the repo the server commits.
const IGNORE = join(SHARED, '.gitignore');
const ignored = existsSync(IGNORE) ? readFileSync(IGNORE, 'utf8').split('\n') : [];
const missing = ['.venv/', '__pycache__/', '*.pyc'].filter(l => !ignored.includes(l));
if (missing.length) appendFileSync(IGNORE, (ignored.length && ignored.at(-1) !== '' ? '\n' : '') + missing.join('\n') + '\n');
if (RUNAS) {
  for (const d of [SHARED, PUBLIC, JOBS, TASKS, IGNORE]) own(d);
  if (!existsSync(join(SHARED, '.git'))) spawnSync('git', ['init', '-q'], { cwd: SHARED, uid: RUNAS.uid, gid: RUNAS.gid });
}
// git as the agent user, committing as member `a`.
export const git = (a, cwd, ...args) => spawnSync('git', ['-c', `user.name=${a}`, '-c', `user.email=${a}@agent-chat`, ...args],
  { cwd, uid: RUNAS.uid, gid: RUNAS.gid, env: { HOME: RUNAS.home, PATH: process.env.PATH }, encoding: 'utf8' });
// After a member's turn, job or task, whatever changed in the shared repo (or a task's worktree) is committed with that
// member as the author, so the history says who changed what. Big files (replays, data dumps) stay uncommitted.
const COMMIT_MAX = 500e3; // ponytail: size cut instead of per-project ignore rules; the members can add .gitignore lines
export function commitShared(a, message, dir = SHARED) {
  if (!RUNAS) return;
  git(a, dir, 'add', '-A');
  const big = git(a, dir, 'diff', '--cached', '--name-only', '--diff-filter=AM', '-z').stdout.split('\0')
    .filter(f => f && statSync(join(dir, f), { throwIfNoEntry: false })?.size > COMMIT_MAX);
  for (let i = 0; i < big.length; i += 100) git(a, dir, 'reset', '-q', '--', ...big.slice(i, i + 100));
  git(a, dir, 'commit', '-q', '-m', message);
}
