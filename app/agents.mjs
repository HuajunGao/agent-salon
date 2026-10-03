// CLI adapters: one headless process per turn, resuming the agent's own CLI session.
// Flags and pitfalls: see PLAN.md and ~/.claude/skills/delegate-agents/run-agent.sh.
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const H = homedir();
const where = name => {
  try { return execFileSync('where.exe', [name], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean); } catch { return []; }
};
const exe = name => where(name).find(p => /\.exe$/i.test(p)) || name;

// The codex on PATH lags the Codex app's bundled CLI and rejects new models: use the newest bundled one.
function codexBin() {
  const d = join(H, 'AppData/Local/OpenAI/Codex/bin');
  try {
    const bins = readdirSync(d).map(x => join(d, x, 'codex.exe')).filter(existsSync);
    if (bins.length) return bins.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {}
  return exe('codex');
}
// opencode on PATH is an npm .cmd shim; spawn the real exe so arguments aren't re-parsed by cmd.exe.
function opencodeBin() {
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

const short = (s, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s);

export const AGENTS = {
  claude: {
    label: 'Claude', color: '#d97757',
    cmd: (prompt, sid, o) => ({
      bin: exe('claude'), env: cleanEnv(),
      args: ['-p', prompt, '--output-format', 'stream-json', '--verbose',
        '--settings', '{"disableAllHooks":true}', '--add-dir', o.dataDir,
        '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell',
        ...(sid ? ['--resume', sid] : [])],
    }),
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
    label: 'Codex', color: '#10a37f',
    cmd: (prompt, sid) => ({
      bin: codexBin(), env: process.env,
      // resume ignores the original model/sandbox and reads ~/.codex/config.toml: pass them every time.
      args: ['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-6.1-sol', '-c', 'sandbox_mode=read-only',
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
    label: 'Gemini', color: '#4285f4',
    cmd: (prompt, sid) => ({
      bin: exe('agy'), env: process.env,
      args: ['-p', prompt, '--model', 'gemini-3.8-flash-medium', '--output-format', 'stream-json', '--mode', 'plan',
        ...(sid ? ['--conversation', sid] : [])],
    }),
    parse(ev, st) {
      if (ev.conversation_id) st.sid = ev.conversation_id;
      const u = ev.step_update;
      if (u?.text_delta) st.live(u.text_delta, true);
      if (u?.tool_name && u.state === 'ACTIVE') st.live(`🔧 ${u.tool_name}`);
      if (ev.result) {
        st.sid = ev.result.conversation_id || st.sid;
        ev.result.status === 'SUCCESS' ? (st.text = ev.result.response) : (st.error = `agy ${ev.result.status}`);
      }
    },
  },
  opencode: {
    label: 'GLM', color: '#7c5cff',
    cmd: (prompt, sid) => ({
      bin: opencodeBin(),
      // --pure: oh-my-openagent hands work to background tasks that die with `run`. 32k default output cap truncates GLM.
      env: { ...process.env, OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: '131072' },
      args: ['run', '--pure', '--agent', 'plan', '-m', 'zai-coding-plan/glm-5.3', '--format', 'json',
        ...(sid ? ['-s', sid] : []), prompt],
    }),
    parse(ev, st) {
      if (ev.sessionID) st.sid = ev.sessionID;
      const p = ev.part || {};
      if (ev.type === 'text') { st.parts.push(p.text); st.live(p.text); }
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
export function runTurn(agent, prompt, sid, { cwd, dataDir, onLive }) {
  const a = AGENTS[agent];
  const { bin, args, env } = a.cmd(prompt, sid, { dataDir });
  const t0 = Date.now();
  let log = '';
  const st = {
    sid, text: '', error: '', parts: [],
    live(s, inline) { log = (log + (inline ? '' : '\n') + s).slice(-6000); onLive(log); },
  };
  return new Promise(resolve => {
    let raw = '', buf = '', killed = '';
    const p = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const kill = why => { killed = why; spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); };
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
