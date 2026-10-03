// CLI adapters: one headless process per turn, resuming the agent's own CLI session.
// Flags and pitfalls: see PLAN.md and ~/.claude/skills/delegate-agents/run-agent.sh.
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { providerConfig } from './members.mjs';

let H = homedir();
const WIN = process.platform === 'win32';

// Optional (Linux, server running as root): run every CLI as an unprivileged user, so agents can be given write and
// execute rights while the OS keeps them away from the database and the server's files. Set from AGENT_USER.
let RUNAS = null; // {name, uid, gid, home}
export function runAs(name) {
  const line = readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.startsWith(name + ':'));
  if (!line) throw new Error(`AGENT_USER ${name} does not exist`);
  const [, , uid, gid, , home] = line.split(':');
  H = home;
  return (RUNAS = { name, uid: +uid, gid: +gid, home });
}
const userEnv = env => (RUNAS ? { ...env, HOME: RUNAS.home, USER: RUNAS.name, LOGNAME: RUNAS.name,
  PATH: [join(RUNAS.home, '.local/bin'), join(RUNAS.home, '.opencode/bin'), env.PATH].join(delimiter) } : env);
const asUser = () => (RUNAS ? { uid: RUNAS.uid, gid: RUNAS.gid } : {});

// All matches for `name` on PATH (Windows: also name.exe / name.cmd).
const where = name => (userEnv(process.env).PATH || '').split(delimiter).filter(Boolean)
  .flatMap(d => (WIN ? ['.exe', '.cmd', ''] : ['']).map(ext => join(d, name + ext))).filter(existsSync);
const exe = name => (WIN ? where(name).find(p => /\.exe$/i.test(p)) : where(name)[0]) || name;

// The codex on PATH lags the Codex app's bundled CLI and rejects new models: use the newest bundled one.
function codexBin() {
  if (!WIN) return exe('codex');
  const d = join(H, 'AppData/Local/OpenAI/Codex/bin');
  try {
    const bins = readdirSync(d).map(x => join(d, x, 'codex.exe')).filter(existsSync);
    if (bins.length) return bins.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {}
  return exe('codex');
}
// opencode 2.x changed `run` flags (see the adapter); ask its version once (stdout to a file, see `out` below).
let ocV2;
function opencodeV2() {
  if (ocV2 != null) return ocV2;
  const f = join(tmpdir(), `agent-chat-ocv-${process.pid}`), fd = openSync(f, 'w');
  try { spawnSync(opencodeBin(), ['--version'], { stdio: ['ignore', fd, 'ignore'], windowsHide: true, timeout: 30e3 }); } catch {}
  closeSync(fd);
  const v = readFileSync(f, 'utf8'); rmSync(f, { force: true });
  return (ocV2 = +(v.match(/(\d+)\.\d+/)?.[1] || 1) >= 2);
}
// opencode on PATH is an npm .cmd shim; spawn the real exe so arguments aren't re-parsed by cmd.exe.
function opencodeBin() {
  if (!WIN) return exe('opencode');
  const cmd = where('opencode').find(p => /\.cmd$/i.test(p));
  const bin = cmd && join(dirname(cmd), 'node_modules/opencode-ai/bin/opencode.exe');
  return bin && existsSync(bin) ? bin : exe('opencode');
}

const cleanEnv = () => {
  // Inside the Claude desktop app these override the CLI's own login (401 / "Not logged in").
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$)/.test(k)) delete env[k];
  return env;
};

// Claude Code on GLM: endpoint, token and model mapping live in ~/.claude/settings-glm.json (the user's claude-glm
// setup). --settings takes one file, so merge in disableAllHooks (Ponytail's hook injects a persona) into a temp copy.
let glmSettings;
function glmSettingsFile() {
  if (glmSettings) return glmSettings;
  const g = JSON.parse(readFileSync(join(H, '.claude/settings-glm.json'), 'utf8'));
  glmSettings = join(tmpdir(), `agent-chat-glm-${process.pid}.json`);
  writeFileSync(glmSettings, JSON.stringify({ ...g, disableAllHooks: true }));
  process.on('exit', () => rmSync(glmSettings, { force: true })); // the copy holds the GLM token
  return glmSettings;
}

// Plain OpenCode: --pure drops plugins; this switches off every MCP server from the user's global config for
// agent-chat's runs only (Playwright via npx alone added ~5 s per turn). Built-in webfetch and skills stay.
let ocNoMcp;
function opencodeNoMcp() {
  if (ocNoMcp != null) return ocNoMcp;
  let names = [];
  for (const f of ['opencode.jsonc', 'opencode.json']) try {
    const text = readFileSync(join(H, '.config/opencode', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    names.push(...Object.keys(JSON.parse(text).mcp || {}));
  } catch {}
  return (ocNoMcp = JSON.stringify({ mcp: Object.fromEntries(names.map(n => [n, { type: 'local', command: ['none'], enabled: false }])) }));
}

const CLAUDE_TOOLS = exec => ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', ...(exec ? ['Bash', 'Edit', 'Write'] : [])];

const short = (s, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s);

export const AGENTS = {
  claude: {
    label: 'Claude Code', color: '#d97757', defaultModel: '',
    // "glm:<alias>" runs Claude Code against GLM through settings-glm.json; anything else is an Anthropic model.
    cmd: (prompt, sid, o) => {
      const glm = o.model?.startsWith('glm:'), model = glm ? o.model.slice(4) : o.model;
      // Plain Claude Code: no user settings (so no plugins such as Ponytail's "write less" persona), no skills,
      // no MCP. Login still comes from ~/.claude/.credentials.json. Read-only tools plus web search.
      return { bin: exe('claude'), env: cleanEnv(),
      args: ['-p', prompt, '--output-format', 'stream-json', '--verbose',
        '--setting-sources', 'project', '--disable-slash-commands', '--strict-mcp-config',
        '--settings', glm ? glmSettingsFile() : '{"disableAllHooks":true}', '--add-dir', o.dataDir,
        ...(model ? ['--model', model] : []),
        // --tools limits what exists; --allowedTools pre-approves it (-p can't ask, so web tools were refused).
        // exec mode (only when the OS confines the agent user) adds editing and Bash.
        '--tools', ...CLAUDE_TOOLS(o.exec), '--allowedTools', ...CLAUDE_TOOLS(o.exec),
        ...(sid ? ['--resume', sid] : [])] };
    },
    parse(ev, st) {
      if (ev.session_id) st.sid = ev.session_id;
      if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
        if (c.type === 'text') st.live(c.text);
        if (c.type === 'tool_use') st.live(`🔧 ${c.name} ${short(JSON.stringify(c.input), 120)}`);
      }
      if (ev.type === 'result') ev.is_error ? (st.error = ev.result || ev.subtype) : (st.text = ev.result);
    },
  },
  codex: {
    label: 'Codex', color: '#10a37f', defaultModel: '',
    cmd: (prompt, sid, o) => ({
      bin: codexBin(), env: process.env,
      // Plain Codex: --ignore-user-config skips ~/.codex/config.toml (plugins, MCP servers, reasoning effort);
      // auth still comes from CODEX_HOME. Model and sandbox are passed every time (resume would not keep them).
      args: ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', ...(o.model ? ['-m', o.model] : []),
        // exec mode: Codex's own OS sandbox confines writes to its workspace (verified in the LXC); network for installs.
        ...(o.exec ? ['-c', 'sandbox_mode=workspace-write', '-c', 'sandbox_workspace_write.network_access=true']
          : ['-c', 'sandbox_mode=read-only']), '-c', 'web_search="live"',
        ...(sid ? ['resume', sid] : []), prompt],
    }),
    parse(ev, st) {
      if (ev.type === 'thread.started') st.sid = ev.thread_id;
      const it = ev.item;
      if (ev.type === 'item.completed' && it) {
        if (it.type === 'agent_message') { st.text = it.text; st.live(it.text); }
        else if (it.type === 'reasoning') st.live(`💭 ${short(it.text || '')}`);
        else if (it.type === 'command_execution') st.live(`🔧 ${short(it.command || '', 120)}`);
      }
      if (ev.type === 'turn.failed') st.error = ev.error?.message || 'turn failed';
      if (ev.type === 'error') st.error = ev.message;
    },
  },
  agy: {
    label: 'Antigravity', color: '#4285f4', defaultModel: '',
    cmd: (prompt, sid, o) => ({
      bin: exe('agy'), env: process.env,
      // Read-only: plan mode. exec mode: approve everything (headless agy can't ask; the OS user is the boundary).
      args: ['-p', prompt, ...(o.model ? ['--model', o.model] : []), '--output-format', 'stream-json',
        ...(o.exec ? ['--dangerously-skip-permissions'] : ['--mode', 'plan']), ...(sid ? ['--conversation', sid] : [])],
    }),
    parse(ev, st) {
      if (ev.conversation_id) st.sid = ev.conversation_id;
      const u = ev.step_update;
      if (u?.text_delta) st.live(u.text_delta, true);
      if (u?.tool_name && u.state === 'ACTIVE') st.live(`🔧 ${u.tool_name}`);
      if (ev.result) {
        st.sid = ev.result.conversation_id || st.sid;
        ev.result.status === 'SUCCESS' ? (st.text = ev.result.response) : (st.error = `agy ${ev.result.status}`);
        // Headless agy can't prompt: a denied permission ends the turn with an empty response.
        const denied = (ev.result.denied_actions || []).map(d => d.action);
        if (!st.text && denied.length) st.error = `agy 权限被拒（${denied.join(', ')}），本轮无输出`;
      }
    },
  },
  opencode: {
    label: 'OpenCode', color: '#7c5cff', defaultModel: '',
    cmd: (prompt, sid, o) => ({
      bin: opencodeBin(),
      // 32k default output cap truncates GLM. v1: --pure (oh-my-openagent hands work to background tasks that die with
      // `run`). v2 dropped --pure and runs through a shared background service by default; --standalone gives each
      // run a private server, so this run's environment (output cap, MCP off) applies.
      env: { ...process.env, AGENT_CHAT_MEMBER_API_KEY: o.member?.apiKey || '', OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: '131072',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...JSON.parse(opencodeNoMcp()), ...providerConfig(o.member, opencodeV2()) }) },
      // Read-only: the plan agent. exec mode: the build agent, auto-approving (v2 --auto) inside the OS-confined user.
      args: ['run', opencodeV2() ? '--standalone' : '--pure', '--agent', o.exec ? 'build' : 'plan',
        ...(o.exec && opencodeV2() ? ['--auto'] : []), ...(o.model ? ['-m', o.model] : []),
        '--format', 'json', ...(sid ? ['-s', sid] : []), prompt],
    }),
    parse(ev, st) {
      if (ev.sessionID) st.sid = ev.sessionID;
      const p = ev.part || {};
      // v2 emits no step_finish, so keep the text current as it arrives.
      if (ev.type === 'text') { st.parts.push(p.text); st.live(p.text); st.text = st.parts.join(''); }
      if (ev.type === 'tool_use') { st.parts = []; st.live(`🔧 ${p.tool} ${short(JSON.stringify(p.state?.input || {}), 120)}`); }
      if (ev.type === 'step_finish') {
        if (p.reason === 'length') st.error = 'output cap hit (reason=length)';
        st.text = st.parts.join('');
      }
      if (ev.type === 'error') st.error = ev.error?.data?.message || ev.error?.name || 'opencode error';
    },
  },
};

// Never trust exit codes: classify the raw output too.
const FAIL = [
  [/hit your usage limit|usage limit reached|rate.?limit|quota/i, 'quota'],
  [/Not logged in|Failed to authenticate|API Error: 401|Invalid bearer token/i, 'auth'],
  [/not supported when using|model_not_found/i, 'bad-model'],
];

const IDLE_MS = 5 * 60e3, TOTAL_MS = 15 * 60e3;

// Run one turn. onLive(text) receives a readable live log. Resolves {text, sid, error, ms}.
export function runTurn(agent, prompt, sid, { cwd, dataDir, model, exec, member, onLive }) {
  const a = AGENTS[agent];
  const { bin, args, env } = a.cmd(prompt, sid, { dataDir, model, exec, member });
  const t0 = Date.now();
  let log = '';
  const st = {
    sid, text: '', error: '', parts: [],
    live(s, inline) { log = (log + (inline ? '' : '\n') + s).slice(-6000); onLive(log); },
  };
  return new Promise(resolve => {
    let raw = '', buf = '', killed = '';
    // On Linux the CLI gets its own process group so a timeout can kill everything it started.
    // PWD too: Node doesn't update it for cwd, and some CLIs (opencode 2, agy) take their project directory from it.
    const p = spawn(bin, args, { cwd, env: { ...userEnv(env), PWD: cwd }, ...asUser(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !WIN });
    const kill = why => {
      killed = why;
      if (WIN) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
      else try { process.kill(-p.pid, 'SIGKILL'); } catch {}
    };
    let idle = setTimeout(() => kill('idle timeout'), IDLE_MS);
    const total = setTimeout(() => kill('total timeout'), TOTAL_MS);
    const onData = d => {
      clearTimeout(idle); idle = setTimeout(() => kill('idle timeout'), IDLE_MS);
      const s = d.toString('utf8');
      raw = (raw + s).slice(-20000);
      buf += s;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim().startsWith('{')) continue;
        try { a.parse(JSON.parse(l), st); } catch {}
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const done = code => {
      clearTimeout(idle); clearTimeout(total);
      if (buf.trim().startsWith('{')) try { a.parse(JSON.parse(buf), st); } catch {}
      let error = killed || st.error;
      if (!error) for (const [re, why] of FAIL) if (re.test(raw) && !st.text) { error = why; break; }
      if (!error && !st.text?.trim()) error = `no reply (exit ${code}): ${short(raw.trim().split('\n').slice(-3).join(' '), 300)}`;
      resolve({ text: (st.text || '').trim(), sid: st.sid, error, ms: Date.now() - t0 });
    };
    p.on('error', e => { st.error = `spawn failed: ${e.message}`; done(-1); });
    p.on('close', done);
  });
}

// ---------- model lists, read once from each CLI ----------
// stdout goes to a temp file, not a pipe: opencode v2 (a Bun binary) loses buffered output written to Node's pipe
// when it exits, so `opencode models` came back empty on Linux.
const out = (bin, args) => new Promise(res => {
  const f = join(tmpdir(), `agent-chat-out-${process.pid}-${Math.random().toString(36).slice(2)}`), fd = openSync(f, 'w');
  const read = () => { closeSync(fd); let s = ''; try { s = readFileSync(f, 'utf8'); rmSync(f, { force: true }); } catch {} return s; };
  const p = spawn(bin, args, { env: userEnv(process.env), ...asUser(), stdio: ['ignore', fd, 'ignore'], windowsHide: true });
  const t = setTimeout(() => p.kill(), 90e3);
  p.on('close', () => { clearTimeout(t); res(read()); }); p.on('error', () => { clearTimeout(t); res(read()); });
});
const lines = s => s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

// Returns {agent: [{id, name}]}; id '' = the CLI's own default.
export async function listModels() {
  const [codex, agy, oc] = await Promise.all([
    out(codexBin(), ['debug', 'models']), out(exe('agy'), ['models']), out(opencodeBin(), ['models'])]);
  let codexList = [];
  try { codexList = JSON.parse(codex).models.filter(m => m.visibility === 'list').map(m => ({ id: m.slug, name: m.display_name })); } catch {}
  return {
    // Claude Code has no list command: aliases resolve to the latest model of each family.
    claude: [{ id: '', name: 'CLI 默认模型（可手动填写模型）' }],
    codex: codexList,
    agy: lines(agy).filter(l => l.includes('\t')).map(l => { const [id, name] = l.split('\t'); return { id, name }; }),
    opencode: lines(oc).filter(l => /^[\w.-]+\/\S+$/.test(l)).map(id => ({ id, name: id })),
  };
}
