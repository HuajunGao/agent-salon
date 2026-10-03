import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

// Real server + SQLite with a fake harness (records each turn's prompt) and no Jev key, so Auto falls back.
test('discussion modes: Auto fallback, user override reaches the turn prompt, persists and is recorded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-chat-mode-test-'));
  const app = join(root, 'app'); mkdirSync(app);
  for (const f of ['server.mjs', 'members.mjs', 'moderator.mjs', 'memory.mjs', 'index.html'])
    copyFileSync(fileURLToPath(new URL(f, import.meta.url)), join(app, f));
  const turnFile = join(root, 'turn.json');
  writeFileSync(join(app, 'agents.mjs'), `export { AGENTS, runAs } from ${JSON.stringify(new URL('agents.mjs', import.meta.url).href)};
    import {writeFileSync} from 'node:fs';
    export async function listModels(){return {}};
    export async function runTurn(h,p,s,o){writeFileSync(${JSON.stringify(turnFile)},JSON.stringify({p}));return {text:'我的观点。', sid:'s1', ms:1}};`);
  const srv = net.createServer(); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  const port = srv.address().port; await new Promise(r => srv.close(r));
  const url = `http://127.0.0.1:${port}`;
  let child;
  const boot = async () => {
    child = spawn(process.execPath, [join(app, 'server.mjs')], { windowsHide: true, stdio: 'ignore',
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_USER: '', TYPESAFE_API_KEY: '' } });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(r => setTimeout(r, 30)); }
    throw new Error('server did not start');
  };
  const stop = async () => { if (child?.exitCode === null) { const e = once(child, 'exit'); child.kill(); await e; } };
  const post = (route, body = {}) => fetch(url + route, { method: 'POST', body: JSON.stringify(body) });
  const init = async () => {
    const c = new AbortController(), r = await fetch(url + '/events', { signal: c.signal });
    const rd = r.body.getReader(); let s = '';
    while (!s.includes('\n\n')) s += new TextDecoder().decode((await rd.read()).value);
    c.abort(); return JSON.parse(s.split('\n\n')[0].slice(6));
  };
  const until = async f => { for (let i = 0; i < 100; i++) { const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 30)); } };
  try {
    await boot();
    await post('/api/settings', { memory: false, autoStop: false, devil: false, circlePause: false, scheduler: 'algorithm', readSpeed: 100000 });
    let s = await init();
    const id = s.state.chatId;
    assert.deepEqual(s.state.discussionMode, { mode: 'auto', auto: null, effective: 'roundtable', pending: false });

    await post('/api/chat/mode', { id, mode: 'debate' });
    await post('/api/chat/mode', { id, mode: 'chaos' }); // ignored
    s = await init();
    assert.equal(s.state.discussionMode.mode, 'debate');
    assert.equal(s.state.discussionMode.effective, 'debate');
    assert.ok(s.messages.some(m => m.kind === 'moderator' && m.text.includes('辩论')));

    const member = s.state.members.find(m => m.enabled).name;
    await post('/api/send', { text: '远程办公应该成为默认吗？', chat_id: id });
    await post('/api/floor', { agent: member });
    const turn = await until(() => existsSync(turnFile) && JSON.parse(readFileSync(turnFile, 'utf8')));
    assert.ok(turn.p.includes('Discussion mode: DEBATE'));
    assert.ok(!turn.p.includes('Discussion mode: ROUNDTABLE'));
    const agentMsg = await until(async () => (await init()).messages.find(m => m.kind === 'agent'));
    assert.equal(agentMsg.mode, 'debate');

    await post('/api/chat/mode', { id, mode: 'auto' }); // no Jev key: classification fails, fallback applies
    s = await until(async () => { const x = await init(); return !x.state.discussionMode.pending && x; });
    assert.deepEqual(s.state.discussionMode, { mode: 'auto', auto: null, effective: 'roundtable', pending: false });

    await post('/api/chat/mode', { id, mode: 'research' });
    await stop(); await boot();
    assert.equal((await init()).state.discussionMode.mode, 'research');
  } finally { await stop(); rmSync(root, { recursive: true, force: true }); }
});
