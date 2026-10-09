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
  for (const f of ['server.mjs', 'members.mjs', 'modes.mjs', 'game.mjs', 'moderator.mjs', 'memory.mjs', 'speech.mjs', 'index.html'])
    copyFileSync(fileURLToPath(new URL(f, import.meta.url)), join(app, f));
  const log = join(root, 'turns.jsonl');
  // Story turns: the first one passes the baton to @opencode; every turn adds a note. The judge gives a verdict.
  writeFileSync(join(app, 'agents.mjs'), `export { AGENTS, runAs, spawnJob } from ${JSON.stringify(new URL('agents.mjs', import.meta.url).href)};
    import {appendFileSync, writeFileSync} from 'node:fs';
    let story = 0;
    export async function listModels(){return {}};
    let calls = 0;
    export async function runTurn(h,p,s,o){appendFileSync(${JSON.stringify(log)},JSON.stringify({h,at:Date.now(),p,s})+'\\n');
      const entry = p.match(/(\\S+bot\\.py)/)?.[1];
      if (entry && p.includes('training window')) { // a window session: v1 and end early; resumed: v2 and work till stopped
        o.onSid?.('s-'+h);
        if (!s) return (writeFileSync(entry, 'v1 '+h), {text: h+' 试了 v1', sid:'s-'+h, ms:150});
        await new Promise(r => { setTimeout(r, 3000); o.signal.addEventListener('abort', r); }); // after the first probe
        if (!o.signal.aborted) writeFileSync(entry, 'v2 '+h);
        if (!o.signal.aborted) await new Promise(r => o.signal.addEventListener('abort', r));
        return {error:'stopped', ms:1};
      }
      const ms = calls++ < ${slowFirst} ? 5000 : 150; // the first turns can be slow (to stop them)
      await new Promise(r=>{ const t=setTimeout(r,ms); o.signal?.addEventListener('abort',()=>{ clearTimeout(t); r(); }); });
      if (o.signal?.aborted) return {error:'stopped', ms:1};
      const text = p.includes('STORY RELAY') ? h+' 的一段。'+(story++ ? '' : '\\n@opencode')+'\\n[NOTE add] '+h+' 登场'
        : p.includes('You are the judge') ? '评判：正方赢在定义。'
        : p.includes('reply with one line: [ACT]') ? '[ACT] 10\\n守约。'
        : p.includes('the negotiation before round') ? h+' 公开。\\n[DM @codex] '+h+' 的私信' : h+' 发言。';
      return {text, sid:'s-'+h, ms:150}};`);
  const srv = net.createServer(); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  const port = srv.address().port; await new Promise(r => srv.close(r));
  const url = `http://127.0.0.1:${port}`;
  const start = () => spawn(process.execPath, [join(app, 'server.mjs')], { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_USER: '', TYPESAFE_API_KEY: '', HERMES_BASE_URL: '' } });
  let child = start();
  const stop = async () => { if (child.exitCode === null) { const e = once(child, 'exit'); child.kill(); await e; } };
  const up = async () => { for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(r => setTimeout(r, 30)); } };
  const restart = async () => { await stop(); child = start(); await up(); };
  t.after(async () => { await stop(); rmSync(root, { recursive: true, force: true }); });
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
  await up();
  await post('/api/settings', { memory: false, autoStop: false, devil: false, circlePause: false, scheduler: 'algorithm',
    readSpeed: 100000, maxThinkers: 4, turnCap: 1 });
  return { post, init, until, turns, url, root, restart };
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


test('a shared link shows one discussion read-only: its messages live, nothing else', async t => {
  const { post, init, until, url } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/send', { text: '分享测试：周末去哪玩？', chat_id: id });
  const { share } = await (await post('/api/chat/share', { id })).json();
  assert.equal((await (await post('/api/chat/share', { id })).json()).share, share); // one code per discussion
  assert.ok((await fetch(`${url}/s/${share}`)).ok);                                    // the page itself
  // the viewer's event stream: the discussion, then its new messages as they are published
  const c = new AbortController(), rd = (await fetch(`${url}/events?s=${share}`, { signal: c.signal })).body.getReader();
  let buf = '';
  const next = async () => { while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await rd.read()).value);
    const i = buf.indexOf('\n\n'), ev = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2); return ev; };
  const first = await next();
  assert.equal(first.type, 'init');
  assert.deepEqual(first.messages.map(m => m.text), ['分享测试：周末去哪玩？']);
  assert.deepEqual(Object.keys(first.state).sort(), ['chatId', 'members', 'now', 'title', 'type']); // no memory, settings, chats
  await until(async () => (await init()).messages.some(m => m.kind === 'agent'));
  let ev; do ev = await next(); while (ev.type !== 'msg');
  assert.equal(ev.msg.chat_id, id);
  c.abort();
  const bad = (await (await fetch(`${url}/events?s=nope`)).body.getReader().read()).value;
  assert.match(new TextDecoder().decode(bad), /已失效/);
});

test('attachments: uploaded, sent with a message, their paths reach the members, served back safely', async t => {
  const { post, init, until, turns, url } = await server(t);
  const id = (await init()).state.chatId;
  const up = await (await fetch(`${url}/api/upload?name=${encodeURIComponent('预算 表.csv')}`, { method: 'POST', body: 'a,b', headers: { 'content-type': 'text/csv' } })).json();
  assert.equal(up.file.split('/')[0], String(id));
  assert.equal(up.size, 3);
  await post('/api/send', { text: '看看这个表', chat_id: id, files: [up, { file: '999/x.csv', name: 'x' }, { file: `${id}/../../chat.db`, name: 'db' }] });
  const msg = (await init()).messages.find(m => m.kind === 'user');
  assert.deepEqual(JSON.parse(msg.files).map(f => f.name), ['预算 表.csv']); // other discussions' files and paths are refused
  const r = await fetch(`${url}/files/${up.file.split('/').map(encodeURIComponent).join('/')}`);
  assert.equal(await r.text(), 'a,b');
  assert.equal(r.headers.get('content-security-policy'), 'sandbox');
  assert.equal((await fetch(`${url}/files/${id}/..%2F..%2Fchat.db`)).status, 404);
  await until(async () => turns().length >= 1);
  assert.ok(turns()[0].p.includes('预算 表.csv') && turns()[0].p.includes('uploads'));
  // a message can be only attachments
  const up2 = await (await fetch(`${url}/api/upload?name=a.png`, { method: 'POST', body: 'png', headers: { 'content-type': 'image/png' } })).json();
  assert.ok((await post('/api/send', { text: '', chat_id: id, files: [up2] })).ok);
  await until(async () => (await init()).messages.some(m => m.kind === 'user' && m.text === '' && m.files));
});

test('outsider: a fresh session sees only the user, thinks, then reads the archive; everyone answers its report', async t => {
  const { post, init, until, turns } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'roundtable' });
  await post('/api/send', { text: '怎么打赢 balanced？', chat_id: id });
  await until(async () => (await init()).messages.filter(m => m.kind === 'agent').length >= 4); // turnCap 1: everyone has spoken
  const before = turns().length;
  assert.ok((await post('/api/outsider')).ok);
  const s = await until(async () => { const x = await init(), o = x.messages.find(m => m.role === 'outsider');
    return o && x.messages.filter(m => m.kind === 'agent' && m.id > o.id).length >= 4 && x; });
  const [one, two] = turns().slice(before);
  assert.ok(one.p.includes('outside expert') && one.p.includes('怎么打赢 balanced？') && !one.p.includes('发言。')); // no group talk
  assert.ok(two.p.includes('Now read what the group has done') && two.h === one.h);
  const o = s.messages.find(m => m.role === 'outsider');
  assert.equal(o.sender, one.h);
  assert.ok(turns().slice(before + 2).every(x => x.p.includes(`#${o.id}`) && x.p.includes('outsider:'))); // past the cap, the author too
  assert.equal((await post('/api/outsider')).ok, true); // the rotation moves on
  await until(async () => turns().length >= before + 8);
  assert.notEqual(turns()[before + 6].h, one.h);
});

test('training window: sessions resumed, the frozen referee probes changed entries, a round robin wakes everyone', async t => {
  const { post, init, until, turns, root, restart } = await server(t);
  const ref = join(root, 'workspace', '_shared', 'referees', 'fake'); mkdirSync(ref, { recursive: true });
  writeFileSync(join(ref, 'referee.py'), `import sys, json
if sys.argv[1] == 'probe':
    print('noise'); print(json.dumps({'rate': 0.5 if open(sys.argv[2]).read().startswith('v2') else 0.25, 'games': 4}))
else:
    names = [a.split('=')[0] for a in sys.argv[3:]]
    print(json.dumps({'standings': [{'name': n, 'rate': 1 - i / 4, 'games': 6} for i, n in enumerate(names)], 'replays': ['a_vs_b.html']}))
`);
  await post('/api/settings', { exec: false });
  assert.equal((await post('/api/arena/start', { goal: '写个 bot', minutes: 10, every: 0.02, referee: 'fake' })).status, 500); // exec off
  await post('/api/settings', { exec: true });
  assert.deepEqual((await init()).state.referees, ['fake']);
  assert.ok((await post('/api/arena/start', { goal: '写个最强的 bot', minutes: 10, every: 0.02, referee: 'fake' })).ok);
  const notes = async () => (await init()).messages.filter(m => m.kind === 'moderator').map(m => m.text);
  assert.ok(await until(async () => (await notes()).filter(x => x.includes('📈') && x.includes('25% → **50%**')).length >= 4)); // everyone
  const tt = turns();
  for (const h of ['claude', 'codex', 'agy', 'opencode']) {
    const mine = tt.filter(x => x.h === h);
    assert.ok(mine[0].p.includes('写个最强的 bot') && !mine[0].s && !mine[0].p.includes('发言。')); // goal verbatim, no chat
    assert.ok(mine[1].p.includes('still open') && mine[1].s === 's-' + h);                     // resumed, same session
  }
  assert.ok((await init()).state.arena.members.every(m => m.working && m.rate === 0.5));
  assert.ok((await notes()).some(x => x.includes('📊') && x.includes('25%')));
  // a restart: the window and its CLI sessions carry on, no "interrupted" notes
  await restart();
  assert.ok(await until(async () => turns().length >= 12));
  assert.ok(turns().slice(8).every(x => x.p.includes('still open') && x.s === 's-' + x.h));
  assert.ok((await notes()).every(x => !x.includes('中断')));
  await post('/api/arena/stop');
  const s = await until(async () => { const x = await init(); return x.messages.some(m => m.text.includes('🏆')) && turns().length >= 16 && x; });
  assert.equal(s.state.arena, null);
  assert.ok(s.messages.find(m => m.text.includes('🏆')).text.includes('| 1 |'));
  const meeting = turns().slice(12);
  assert.ok(meeting.every(x => x.p.includes('is over') && x.p.includes('试了 v1')));
  assert.ok(!(await post('/api/arena/start', { goal: 'x', minutes: 10, referee: 'nope' })).ok);
});

test('game mode: talk in turn with private messages, secret simultaneous orders, the host resolves the rounds', async t => {
  const { post, init, until, turns, root } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'game' });
  await post('/api/send', { text: '开始，2 轮', chat_id: id });
  const s = await until(async () => { const x = await init(), end = x.messages.find(m => m.text.startsWith('🏁'));
    return end && x.messages.filter(m => m.kind === 'agent' && m.id > end.id).length >= 4 && x; });
  const g = s.state.game;
  assert.equal(g.over, 'done');
  assert.deepEqual(Object.values(g.caught), [20, 20, 20, 20]); // 10 each, twice: the lake refills to 100
  // private messages: the others' to codex (codex's own to itself is dropped), 2 rounds × 2 laps
  const dms = s.messages.filter(m => m.dm);
  assert.equal(dms.length, 12);
  assert.ok(dms.every(m => m.dm === 'codex' && m.sender !== 'codex' && m.text.endsWith('的私信')));
  const tt = turns(), talk = tt.filter(x => x.p.includes('the negotiation before round')), orders = tt.filter(x => x.p.includes('[ACT] <tonnes>'));
  assert.equal(talk.length, 16);
  assert.equal(orders.length, 8);
  for (let i = 1; i < talk.length; i++) assert.ok(talk[i].at - talk[i - 1].at >= 150, 'talk turns overlap');
  assert.ok(orders[3].at - orders[0].at < 150, 'orders start together');
  assert.ok(tt.filter(x => x.h !== 'codex').every(x => !x.p.includes('的私信')));            // only the addressee reads them
  assert.ok(tt.some(x => x.h === 'codex' && x.p.includes('claude 的私信') && x.p.includes('(private message)')));
  assert.ok(talk.slice(8).every(x => x.p.includes('Round 1: the lake had 100, 40 caught in total (you: 10)')));
  assert.ok(talk.every(x => !x.p.includes('Everyone:')));                                    // catches stay secret
  // orders go to the host only: the user sees them in notes, the members never
  assert.ok(s.messages.filter(m => m.kind === 'agent').every(m => !m.text.includes('守约')));
  assert.equal(s.messages.filter(m => m.kind === 'moderator' && m.text.startsWith('🔒')).length, 8);
  assert.ok(!readFileSync(join(root, 'data', 'discussions', `${id}.md`), 'utf8').includes('的私信'));
  const after = tt.slice(-4);
  assert.ok(after.every(x => x.p.includes('The game is over') && x.p.includes('Everyone:')));
});
