import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { parseReply } from './modes.mjs';

test('parseReply takes the stance line and [HAND] off the reply', () => {
  assert.deepEqual(parseReply('用真实库更可靠，见 #3。\n[STANCE 70%] 集成测试用真实测试库'),
    { text: '用真实库更可靠，见 #3。', hand: false, stance: { t: '集成测试用真实测试库', c: 70 }, notes: [], jobs: [] });
  assert.deepEqual(parseReply('同意。\n**[立场：85%]** 拆分要等团队变大 [HAND]'),
    { text: '同意。', hand: true, stance: { t: '拆分要等团队变大', c: 85 }, notes: [], jobs: [] });
  assert.deepEqual(parseReply('观点。\n[STANCE 60%] 先上单体\n[HAND]'), { text: '观点。', hand: true, stance: { t: '先上单体', c: 60 }, notes: [], jobs: [] });
  assert.deepEqual(parseReply('没有立场行 [HAND]'), { text: '没有立场行', hand: true, stance: null, notes: [], jobs: [] });
  assert.equal(parseReply('PASS').text, 'PASS');
  assert.equal(parseReply('[STANCE 250%] x').stance.c, 100);
  assert.deepEqual(parseReply('好。\n[STANCE 75%] 条件支持：小额、核实过再捐').stance, { t: '小额、核实过再捐', c: 75, l: '条件支持' });
  assert.deepEqual(parseReply('[STANCE 60%] 用真实库，原因：更可靠').stance, { t: '用真实库，原因：更可靠', c: 60 });
});

// Markers that leaked into the chat on the server, as the members wrote them.
test('parseReply finds markers mid-line, several on a line, and before more text', () => {
  assert.deepEqual(parseReply('谁接手都能对上。[STANCE 94%] verdict: 材料封箱，分叉交由双方对拍'),
    { text: '谁接手都能对上。', hand: false, stance: { t: '材料封箱，分叉交由双方对拍', c: 94 }, notes: [], jobs: [] });
  assert.deepEqual(parseReply('可以先排。 [HAND] [STANCE 80%] verdict: 先做一次短期独旅'),
    { text: '可以先排。', hand: true, stance: { t: '先做一次短期独旅', c: 80 }, notes: [], jobs: [] });
  assert.deepEqual(parseReply('出错谁负责。\n\n\n\n[HAND]\n\n\nSources:\n- [newsGP](https://x.example)'),
    { text: '出错谁负责。\n\nSources:\n- [newsGP](https://x.example)', hand: true, stance: null, notes: [], jobs: [] });
  assert.deepEqual(parseReply('坑都在工程侧。[NOTE add] 需 --legacy-peer-deps\n[STANCE 90%] 能落地').notes, [{ op: 'add', text: '需 --legacy-peer-deps' }]);
  // talk about the protocol, in code, isn't a marker
  assert.deepEqual(parseReply('已有 `[NOTE]` 机制，结尾写 `[HAND]` 即可。'),
    { text: '已有 `[NOTE]` 机制，结尾写 `[HAND]` 即可。', hand: false, stance: null, notes: [], jobs: [] });
  assert.equal(parseReply('PASS [HAND]').text, 'PASS');
  assert.deepEqual(parseReply('开跑。\n[JOB] `cd /x && python run.py --resume` [HAND]\n[STANCE 90%] 好').jobs, ['cd /x && python run.py --resume']);
  assert.equal(parseReply('[JOB] a\n[JOB] b\n[JOB] c').jobs.length, 2);
  // [JOB] runs a command: mentioned mid-sentence (as members did on the server) it is text, not a job
  const talk = parseReply('机制第一次真跑就失败了。用 [JOB] 全链路：只写一个文件就退出。\n[NOTE add] [JOB]机制首个探针结果为failed');
  assert.deepEqual(talk.jobs, []);
  assert.ok(talk.text.includes('[JOB] 全链路'));
  assert.deepEqual(talk.notes, [{ op: 'add', text: '[JOB]机制首个探针结果为failed' }]);
  assert.deepEqual(parseReply('好。\n- **[JOB]** `python run.py`').jobs, ['python run.py']);
});

// Real server + SQLite with a fake harness that records when each turn starts; no Jev key.
test('research mode: everyone answers the question at once, stances reach the state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-chat-stance-test-'));
  const app = join(root, 'app'); mkdirSync(app);
  for (const f of ['server.mjs', 'members.mjs', 'modes.mjs', 'moderator.mjs', 'memory.mjs', 'speech.mjs', 'index.html'])
    copyFileSync(fileURLToPath(new URL(f, import.meta.url)), join(app, f));
  const log = join(root, 'turns.jsonl');
  writeFileSync(join(app, 'agents.mjs'), `export { AGENTS, runAs, spawnJob } from ${JSON.stringify(new URL('agents.mjs', import.meta.url).href)};
    import {appendFileSync} from 'node:fs';
    export async function listModels(){return {}};
    export async function runTurn(h,p,s,o){appendFileSync(${JSON.stringify(log)},JSON.stringify({at:Date.now(),p})+'\\n');
      await new Promise(r=>setTimeout(r,400));
      return {text:'我的观点。\\n[STANCE 65%] 先查数据再下结论', sid:'s1', ms:400}};`);
  const srv = net.createServer(); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  const port = srv.address().port; await new Promise(r => srv.close(r));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(app, 'server.mjs')], { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_USER: '', TYPESAFE_API_KEY: '' } });
  const post = (route, body = {}) => fetch(url + route, { method: 'POST', body: JSON.stringify(body) });
  const init = async () => {
    const c = new AbortController(), r = await fetch(url + '/events', { signal: c.signal });
    const rd = r.body.getReader(); let s = '';
    while (!s.includes('\n\n')) s += new TextDecoder().decode((await rd.read()).value);
    c.abort(); return JSON.parse(s.split('\n\n')[0].slice(6));
  };
  const until = async (f, n = 200) => { for (let i = 0; i < n; i++) { const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 30)); } };
  try {
    await until(async () => { try { return (await fetch(url)).ok; } catch {} });
    await post('/api/settings', { memory: false, autoStop: false, devil: false, circlePause: false, scheduler: 'algorithm',
      readSpeed: 100000, maxThinkers: 1, turnCap: 1 });
    const s = await init(), id = s.state.chatId, n = s.state.members.filter(m => m.enabled).length;
    await post('/api/chat/mode', { id, mode: 'research' });
    await post('/api/send', { text: '澳洲央行 11 月会加息吗？', chat_id: id });
    const turns = await until(() => existsSync(log) && (() => { const l = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      return l.length >= n && l; })());
    assert.equal(turns.length, n);
    // maxThinkers is 1, yet everyone started before the first 400 ms turn finished
    assert.ok(Math.max(...turns.map(t => t.at)) - Math.min(...turns.map(t => t.at)) < 300);
    for (const t of turns) assert.ok(t.p.includes('Independent opening') && t.p.includes('[STANCE n%]'));
    const done = await until(async () => { const x = await init(); return x.messages.filter(m => m.kind === 'agent').length === n && x; }, 800); // each publish holds >= 3 s of reading time
    assert.ok(done.messages.some(m => m.kind === 'moderator' && m.text.includes('独立作答')));
    for (const m of done.messages.filter(m => m.kind === 'agent')) assert.equal(m.text, '我的观点。');
    assert.equal(done.state.stances.length, n);
    assert.deepEqual([done.state.stances[0].t, done.state.stances[0].c], ['先查数据再下结论', 65]);
    // a follow-up is discussed normally: one at a time (maxThinkers 1), not an independent round
    await post('/api/send', { text: '那 12 月呢？', chat_id: id });
    const more = await until(() => { const l = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).slice(n);
      return l.length >= 2 && l; }, 400);
    assert.ok(more.every(t => !t.p.includes('Independent opening')));
    assert.ok(more[1].at - more[0].at >= 350);
  } finally {
    if (child.exitCode === null) { const e = once(child, 'exit'); child.kill(); await e; }
    rmSync(root, { recursive: true, force: true });
  }
});
