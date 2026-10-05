import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayNext, debateSetup, debateScript, debateBrief, seatOf, parseReply, applyNotes, rulesOf } from './modes.mjs';

test('story relay: an @mention takes the baton, else the next member in order', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(relayNext(order, null, null, () => 0), 'a');      // the opener is drawn at random
  assert.equal(relayNext(order, null, null, () => 0.99), 'c');
  assert.equal(relayNext(order, null, 'b'), 'b');                // unless the user @mentions one
  assert.equal(relayNext(order, 'a', null), 'b');
  assert.equal(relayNext(order, 'c', null), 'a');
  assert.equal(relayNext(order, 'a', 'c'), 'c');
  assert.equal(relayNext(order, 'a', 'a'), 'b');      // can't hand the baton to yourself
  assert.equal(relayNext(order, 'a', 'zed'), 'b');    // not a member
});

test('debate: sides at random, an odd member out judges, the order of play', () => {
  const even = debateSetup(['a', 'b', 'c', 'd'], () => 0.5);
  assert.equal(even.judge, 'user');
  assert.deepEqual([even.pro.length, even.con.length], [2, 2]);
  assert.deepEqual([...even.pro, ...even.con].sort(), ['a', 'b', 'c', 'd']);
  const odd = debateSetup(['a', 'b', 'c'], () => 0.1);
  assert.ok(odd.judge !== 'user' && !odd.pro.includes(odd.judge) && !odd.con.includes(odd.judge));
  assert.equal(seatOf(even, even.con[1]), '反方二辩');
  assert.equal(seatOf(odd, odd.judge), '评委');

  const d = { pro: ['p1', 'p2'], con: ['c1', 'c2'], judge: 'user' };
  assert.deepEqual(debateScript(d).map(s => `${s.phase}:${s.who || s.side}`), [
    'opening:p1', 'opening:c1', 'rebuttal:p2', 'rebuttal:c2',
    'free:pro', 'free:con', 'free:pro', 'free:con', 'closing:c2', 'closing:p2', 'verdict:user']);
  assert.equal(rulesOf('debate', { done: true }).moderated, true); // after the verdict: free discussion
  // spoken style everywhere but research
  assert.ok(rulesOf('roundtable').prompt.includes('口语化') && rulesOf('debate', { done: true }).prompt.includes('口语化'));
  assert.ok(!rulesOf('research').prompt.includes('口语化'));
  assert.ok(debateBrief(d, 'p1', 'free', 'm', x => x).includes('口语化'));
  assert.equal(rulesOf('debate', { done: false }).flow, 'debate');
});

test('notes: members keep them with [NOTE] lines', () => {
  const r = parseReply('李雷推开了门。\n[NOTE add] 李雷是韩梅梅的表哥\n[NOTE edit N2] 故事发生在 1998 年的上海\n[NOTE drop 5]\n[NOTE edit] 缺编号，忽略\n[HAND]');
  assert.equal(r.text, '李雷推开了门。');
  assert.equal(r.hand, true);
  assert.deepEqual(r.notes, [{ op: 'add', text: '李雷是韩梅梅的表哥' }, { op: 'edit', n: 2, text: '故事发生在 1998 年的上海' }, { op: 'drop', n: 5 }]);
  const list = [{ n: 1, text: 'x' }, { n: 2, text: '1997' }];
  assert.deepEqual(applyNotes(list, r.notes, { author: 'a' }), [{ op: 'add', n: 3 }, { op: 'edit', n: 2 }]); // N5 doesn't exist
  assert.deepEqual(list.map(x => `${x.n}:${x.text}`), ['1:x', '2:故事发生在 1998 年的上海', '3:李雷是韩梅梅的表哥']);
  assert.deepEqual(parseReply('观点。\n[NOTE add] 来源：RBA 9 月声明\n[STANCE 60%] 支持：会加息').stance, { t: '会加息', c: 60, l: '支持' });
});

// ---------- the flows on a real server (SQLite, fake harness that records each turn; no Jev key) ----------
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

async function server(t, slowFirst = 0) {
  const root = mkdtempSync(join(tmpdir(), 'agent-chat-flow-test-'));
  const app = join(root, 'app'); mkdirSync(app);
  for (const f of ['server.mjs', 'members.mjs', 'modes.mjs', 'moderator.mjs', 'memory.mjs', 'speech.mjs', 'index.html'])
    copyFileSync(fileURLToPath(new URL(f, import.meta.url)), join(app, f));
  const log = join(root, 'turns.jsonl');
  // Story turns: the first one passes the baton to @opencode; every turn adds a note. The judge gives a verdict.
  writeFileSync(join(app, 'agents.mjs'), `export { AGENTS, runAs } from ${JSON.stringify(new URL('agents.mjs', import.meta.url).href)};
    import {appendFileSync} from 'node:fs';
    let story = 0;
    export async function listModels(){return {}};
    let calls = 0;
    export async function runTurn(h,p,s,o){appendFileSync(${JSON.stringify(log)},JSON.stringify({h,at:Date.now(),p})+'\\n');
      const ms = calls++ < ${slowFirst} ? 5000 : 150; // the first turns can be slow (to stop them)
      await new Promise(r=>{ const t=setTimeout(r,ms); o.signal?.addEventListener('abort',()=>{ clearTimeout(t); r(); }); });
      if (o.signal?.aborted) return {error:'stopped', ms:1};
      const text = p.includes('STORY RELAY') ? h+' 的一段。'+(story++ ? '' : '\\n@opencode')+'\\n[NOTE add] '+h+' 登场'
        : p.includes('You are the judge') ? '评判：正方赢在定义。' : h+' 发言。';
      return {text, sid:'s-'+h, ms:150}};`);
  const srv = net.createServer(); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  const port = srv.address().port; await new Promise(r => srv.close(r));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(app, 'server.mjs')], { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_USER: '', TYPESAFE_API_KEY: '', HERMES_BASE_URL: '' } });
  t.after(async () => { if (child.exitCode === null) { const e = once(child, 'exit'); child.kill(); await e; } rmSync(root, { recursive: true, force: true }); });
  const post = (route, body = {}) => fetch(url + route, { method: 'POST', body: JSON.stringify(body) });
  const init = async () => {
    const c = new AbortController(), r = await fetch(url + '/events', { signal: c.signal });
    const rd = r.body.getReader(); let s = '';
    while (!s.includes('\n\n')) s += new TextDecoder().decode((await rd.read()).value);
    c.abort(); return JSON.parse(s.split('\n\n')[0].slice(6));
  };
  // Polls f, skipping each reply's reading time ("next"), so the flow runs at test speed.
  const until = async f => { for (let i = 0; i < 600; i++) { await post('/api/next'); const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 30)); } };
  const turns = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []);
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 30)); }
  await post('/api/settings', { memory: false, autoStop: false, devil: false, circlePause: false, scheduler: 'algorithm',
    readSpeed: 100000, maxThinkers: 4, turnCap: 1 });
  return { post, init, until, turns };
}

test('story mode: one member at a time, an @mention takes the baton, notes kept by the members', async t => {
  const { post, init, until, turns } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'story' });
  await post('/api/send', { text: '开个头：雨夜，一封没有署名的信。@claude 你先来', chat_id: id });
  const s = await until(async () => { const x = await init(); return x.messages.filter(m => m.kind === 'agent').length >= 4 && x; });
  assert.deepEqual(s.messages.filter(m => m.kind === 'agent').map(m => m.sender), ['claude', 'opencode', 'codex', 'agy']);
  const tt = turns();
  for (let i = 1; i < tt.length; i++) assert.ok(tt[i].at - tt[i - 1].at >= 150, 'turns overlap'); // the next waits for the previous
  assert.ok(tt[2].p.includes('N1 claude 登场') && tt[2].p.includes('N2 opencode 登场'));
  assert.ok(!tt[0].p.includes('[STANCE'));
  assert.deepEqual(s.state.notes.map(x => [x.n, x.text, x.by]), [[1, 'claude 登场', 'claude'], [2, 'opencode 登场', 'opencode'],
    [3, 'codex 登场', 'codex'], [4, 'agy 登场', 'agy']]);
  assert.equal(s.messages.find(m => m.sender === 'claude').note_ops, JSON.stringify([{ op: 'add', n: 1 }]));
  assert.ok(s.messages.every(m => !m.text.includes('[NOTE')));
});

test('debate mode: sides drawn, the order of play, an AI judge, then free discussion', async t => {
  const { post, init, until, turns } = await server(t);
  await post('/api/settings', { enabled: { opencode: false } }); // three members: one judges
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'debate' });
  await post('/api/send', { text: '远程办公应该成为默认吗？', chat_id: id });
  const s = await until(async () => { const x = await init();
    const after = x.messages.findIndex(m => m.text.includes('辩论结束'));
    return after >= 0 && x.messages.slice(after).filter(m => m.kind === 'agent').length >= 3 && x; });
  const talk = s.messages.filter(m => m.kind === 'agent');
  assert.deepEqual(talk.slice(0, 7).map(m => m.seat), ['正方一辩', '反方一辩', '正方一辩', '反方一辩', '反方一辩', '正方一辩', '评委']);
  assert.equal(talk[6].role, 'verdict');
  assert.equal(s.state.debate.done, true);
  assert.ok(s.messages.some(m => m.kind === 'moderator' && m.text.includes('抽签结果')));
  const judge = talk[6].sender, tt = turns();
  assert.ok(tt.slice(0, 6).every(x => x.h !== judge && x.p.includes('Debate on the motion')));
  assert.ok(tt.slice(7).every(x => x.p.includes('The formal debate is over')));          // free discussion, all three
  assert.deepEqual(new Set(tt.slice(7).map(x => x.h)).size, 3);
});

test('debate mode with an even number: the user judges, and the verdict opens free discussion', async t => {
  const { post, init, until } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'debate' });
  await post('/api/send', { text: '该不该提前还房贷？', chat_id: id });
  await until(async () => (await init()).messages.some(m => m.text.includes('请你作为评委')));
  const all = (await init()).messages, before = all.filter(m => m.kind === 'agent').length;
  assert.equal(before, 10); // 2 openings, 2 rebuttals, 4 free, 2 closings
  // each phase note sits between the last reply of one phase and the first of the next (not before a queued reply)
  const order = all.filter(m => m.kind === 'agent' || /进入|结辩结束/.test(m.text)).map(m => m.kind === 'agent' ? m.seat : m.text);
  assert.deepEqual(order, ['正方一辩', '反方一辩', '🧭 进入驳论。', '正方二辩', '反方二辩', '🧭 进入自由辩。',
    ...order.slice(6, 10), '🧭 进入结辩。', '反方二辩', '正方二辩', '🧭 结辩结束。请你作为评委判胜负、说说理由；你发言后进入自由讨论。']);
  await post('/api/send', { text: '我判反方赢：现金流更重要。', chat_id: id });
  const s = await until(async () => { const x = await init(); return x.messages.filter(m => m.kind === 'agent').length > before && x; });
  assert.equal(s.state.debate.done, true);
  assert.ok(s.messages.some(m => m.text.includes('辩论结束')));
});

test('stop: cancels thinking turns, drops what was not published, and the next message carries on', async t => {
  const { post, init, until, turns } = await server(t, 4); // the four opening turns take 5 s
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'roundtable' });
  await post('/api/send', { text: '远程办公好吗？', chat_id: id });
  await until(async () => turns().length >= 4);
  await post('/api/stop');
  let s = await init();
  assert.ok(s.state.members.every(m => m.status !== 'thinking'));
  assert.equal(s.state.queue.length, 0);
  assert.equal(s.state.paused, false);
  await new Promise(r => setTimeout(r, 500));
  s = await init();
  assert.equal(s.messages.filter(m => m.kind === 'agent').length, 0); // nothing posted, no error notes
  assert.equal(s.messages.filter(m => m.kind === 'system').length, 0);
  assert.equal(turns().length, 4);                                      // and nothing new started
  await post('/api/send', { text: '那就简单说说吧', chat_id: id });
  await until(async () => (await init()).messages.some(m => m.kind === 'agent'));
});
