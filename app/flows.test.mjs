import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyApp } from './testkit.mjs';
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

test('[FILE] lines: a file to attach, taken off the text', () => {
  const r = parseReply('画好了。\n[FILE] `out/pic.png`\n- [FILE] /tmp/a.txt\n别把 [FILE] x 当成附件');
  assert.deepEqual(r.files, ['out/pic.png', '/tmp/a.txt']);
  assert.equal(r.text, '画好了。\n\n别把 [FILE] x 当成附件');
});

// ---------- the flows on a real server (SQLite, fake harness that records each turn; no Jev key) ----------
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

async function server(t, slowFirst = 0) {
  const root = mkdtempSync(join(tmpdir(), 'agent-chat-flow-test-'));
  const app = copyApp(root);
  const log = join(root, 'turns.jsonl');
  // Story turns: the first one passes the baton to @opencode; every turn adds a note. The judge gives a verdict.
  writeFileSync(join(app, 'agents.mjs'), `export { AGENTS, runAs, spawnJob } from ${JSON.stringify(new URL('agents.mjs', import.meta.url).href)};
    import { appendFileSync, writeFileSync } from 'node:fs';
    let story = 0;
    export const installed = () => true;
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
        : /暂停测试|程序修好了吗/.test(p) && p.includes('You are the HOST') ? (/this is turn 1\\)/.test(p)
            ? '程序校验失败，先停一下。\\n[PAUSE]\\n[STATE]\\n账本 A' : '修好了，结束。\\n[END]\\n[STATE]\\n账本 B')
        : p.includes('@user is the human user') && p.includes('You are the HOST') ? ['', '规则：猜数。\\n[DM @user] 你的数字是 9\\n[DM @codex] 你的数字是 7\\n[PHASE talk @user @agy]\\n[STATE]\\n账本 U1',
            '交指令。\\n[PHASE orders @user @codex]\\n[STATE]\\n账本 U2', '结算：你赢。\\n[END]\\n[STATE]\\n账本 U3'][+p.match(/this is turn (\\d+)/)[1]]
        : p.includes('You are the HOST') ? ['','规则：猜数。\\n[DM @codex] 你的数字是 7\\n[DM @agy] 你的数字是 3\\n[PHASE talk @opencode @agy]\\n[STATE]\\n回合 1',
            '交指令。\\n[PHASE orders @codex]\\n[STATE]\\n回合 2', '结算：codex 赢。\\n[END]\\n[STATE]\\n结束'][+p.match(/this is turn (\\d+)/)[1]]
        : p.includes('the host asks for your order') ? (o.onLive('🔧 Read /home/agent/.codex/sessions/x.jsonl'), '[ACT] 猜 5\\n凭直觉')
        : p.includes('取名测试') && h === 'claude' ? '我是老狐狸。\\n[NAME] 老狐狸\\n[NOTE add] 狐狸登场'
        : p.includes('取名测试') && h === 'codex' ? '我也取一个。\\n[NAME] claude2'
        : p.includes('改名吧') ? '好。\\n[NAME] 黑猫'
        : p.includes('附件测试') && h === 'claude' ? (writeFileSync(o.cwd+'/pic.png', 'png'), writeFileSync(o.cwd+'/avatar.png', 'av'),
            '画好了。\\n[FILE] pic.png\\n[FILE] ../../app/server.mjs')
        : h+' 发言。';
      const mate = p.includes('私信测试') && p.match(/Your teammates?: @(\\w+)/)?.[1]; // debate: a word to the teammate
      return {text: mate ? text+'\\n[DM @'+mate+'] '+h+' 的暗号' : text, sid:'s-'+h, ms:150}};`);
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


test('debate: teammates may coordinate by private message, unseen by the other side', async t => {
  const { post, init, until, turns } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'debate' });
  await post('/api/send', { text: '私信测试：该不该提前还房贷？', chat_id: id });
  const s = await until(async () => { const x = await init(); return x.messages.some(m => m.text.includes('请你作为评委')) && x; });
  const d = s.state.debate, side = n => (d.pro.includes(n) ? 'pro' : 'con'), dms = s.messages.filter(m => m.dm);
  assert.equal(dms.length, 10);                                                   // one per debate turn
  assert.ok(dms.every(m => m.dm !== m.sender && side(m.dm) === side(m.sender)));
  for (const x of turns()) for (const m of dms) if (x.p.includes(m.text)) assert.equal(x.h, m.dm); // only the addressee
  assert.ok(turns().some(x => x.p.includes('的暗号') && x.p.includes('(private message)')));
});

test('game mode: a member hosts with a private ledger, DMs the setup, collects secret orders, ends; peeking is flagged', async t => {
  const { post, init, until, turns, root } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'game' });
  await post('/api/send', { text: '我们玩个猜数游戏', chat_id: id });                                // no host named: asked for one
  await until(async () => (await init()).messages.some(m => m.text.startsWith('🎲 博弈要有人主持')));
  await post('/api/send', { text: '@claude 主持，我们玩个猜数游戏', chat_id: id });
  const s = await until(async () => { const x = await init();
    return x.state.game?.over && x.messages.filter(m => m.kind === 'agent' && !m.dm && m.text.endsWith('发言。')).length >= 6 && x; });
  assert.deepEqual([s.state.game.host, s.state.game.over, s.state.game.ledger], ['claude', 'end', '结束']);
  const tt = turns(), host = tt.filter(x => x.p.includes('You are the HOST'));
  assert.equal(host.length, 3);
  assert.ok(host[0].p.includes('This is your first turn') && host[1].p.includes('回合 1'));          // the ledger comes back
  assert.ok(host[2].p.includes('secret order') && host[2].p.includes('[ACT] 猜 5'));                // the order reached the host
  assert.ok(s.messages.every(m => !m.text.includes('[STATE]') && !m.text.includes('回合 1') && !m.text.includes('[PHASE')));
  const dm = s.messages.find(m => m.text === '你的数字是 7');
  assert.ok(!readFileSync(join(root, 'data', 'discussions', `${id}.md`), 'utf8').includes('你的数字是'));           // DMs stay out of the archive
  assert.equal(dm.dm, 'codex');
  assert.ok(tt.filter(x => x.h !== 'codex' && x.h !== 'claude').every(x => !x.p.includes('你的数字是 7')));
  assert.ok(tt.some(x => x.h === 'codex' && x.p.includes('你的数字是 7')));
  const talk = tt.filter(x => x.p.includes('Now: the table talks')), orders = tt.filter(x => x.p.includes('the host asks for your order'));
  assert.deepEqual(talk.map(x => x.h), ['opencode', 'agy']);                                      // the host's order
  assert.ok(s.messages.some(m => m.text === '🎲 轮流发言：@opencode → @agy。'));
  assert.deepEqual(orders.map(x => x.h), ['codex']);                                                // only who the host named
  const order = s.messages.find(m => m.role === 'order');
  assert.deepEqual([order.sender, order.dm], ['codex', 'claude']);
  assert.ok(tt.filter(x => x.h !== 'claude').every(x => !x.p.includes('猜 5')));
  assert.ok(s.messages.some(m => m.kind === 'moderator' && m.text.startsWith('🚨') && m.text.includes('.codex/sessions')));
});

test('game: the user plays too; until it is over the user sees only public messages and its own DMs', async t => {
  const { post, init, until, turns } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/settings', { userPlays: true });
  await post('/api/chat/mode', { id, mode: 'game' });
  await post('/api/send', { text: '@claude 主持，我们玩猜数', chat_id: id });
  let s = await until(async () => { const x = await init(); return x.state.game?.turn === 'user' && x; });
  assert.ok(s.state.game.players.includes('user') && s.state.game.user);
  assert.equal(s.state.game.ledger, '');                                                            // no ledger for a player
  assert.ok(s.messages.some(m => m.text === '你的数字是 9' && m.dm === 'user'));
  assert.ok(!s.messages.some(m => m.text === '你的数字是 7'));                                       // another player's DM
  assert.ok(s.messages.some(m => m.text === '🎲 轮到你发言了。'));
  await post('/api/send', { text: '我猜大数\n[DM @codex] 我们联手', chat_id: id });                     // public + a DM, ends the turn
  s = await until(async () => { const x = await init(); return x.state.game?.phase === 'orders' && x.state.game.turn === 'user' && x; });
  assert.ok(s.messages.some(m => m.sender === 'user' && m.text === '我猜大数' && !m.dm));
  assert.ok(s.messages.some(m => m.sender === 'user' && m.text === '我们联手' && m.dm === 'codex'));
  await post('/api/send', { text: '猜 9', chat_id: id });                                            // the secret order
  s = await until(async () => { const x = await init(); return x.state.game?.over && x; });
  assert.equal(s.state.game.ledger, '账本 U3');                                                     // over: everything shown
  assert.ok(s.messages.some(m => m.text === '你的数字是 7'));
  const order = s.messages.find(m => m.role === 'order' && m.sender === 'user');
  assert.deepEqual([order.text, order.dm], ['猜 9', 'claude']);
  const tt = turns(), host = tt.filter(x => x.p.includes('You are the HOST'));
  assert.ok(host[0].p.includes('@user is the human user') && host[2].p.includes('猜 9'));
  assert.ok(tt.some(x => x.h === 'codex' && x.p.includes('我们联手')));
  assert.ok(tt.filter(x => x.h === 'agy').every(x => !x.p.includes('我们联手') && !x.p.includes('猜 9')));
  assert.deepEqual(tt.filter(x => x.p.includes('Now: the table talks')).map(x => x.h), ['agy']);   // the user's turn wasn't a member's
});
test('Auto: the room waits a few seconds after the mode is picked; switching starts it at once in the new mode', async t => {
  const { post, init, until, turns } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/send', { text: '开个头：雨夜，一封没有署名的信。', chat_id: id });            // Auto (Jev down: roundtable)
  await until(async () => (await init()).state.opening);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(turns().length, 0);                                                              // nobody starts during the hold
  await post('/api/chat/mode', { id, mode: 'story' });
  await until(async () => turns().length >= 1);
  assert.ok(turns()[0].p.includes('STORY RELAY'));                                              // the first turn is in the new mode
  assert.equal((await init()).state.opening, null);
});

test('game: without the host\'s order the talk goes in a random order, everyone once per lap', async () => {
  const { talkOrder } = await import('./game.mjs');
  const q = talkOrder(['a', 'b', 'c'], 2, () => 0);                         // a fixed "random": each lap shuffled the same way
  assert.deepEqual(q, ['b', 'c', 'a', 'b', 'c', 'a']);
  const orders = new Set(Array.from({ length: 200 }, () => talkOrder(['a', 'b', 'c'], 1).join('')));
  assert.equal(orders.size, 6);                                             // every order happens
});

test('game: a DM runs over lines up to the next marker; the host can pause, and the user\'s message resumes it', async t => {
  const { parseReply } = await import('./modes.mjs'), { parseHost } = await import('./game.mjs');
  const h = parseHost('公开。\n[DM @a] 估值：\n| 1A | 55 |\n| 1B | 20 |\n[DM @b] 1A 30\n[PAUSE]\n[STATE]\n账本');
  assert.deepEqual([h.next, h.ledger], [{ kind: 'pause' }, '账本']);
  assert.deepEqual(parseReply(h.body).dms.map(d => [d.to, d.text]), [['a', '估值：\n| 1A | 55 |\n| 1B | 20 |'], ['b', '1A 30']]);
  assert.equal(parseReply(h.body).text, '公开。');                                  // no table line leaks into the public text

  const { post, init, until, turns } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'game' });
  await post('/api/send', { text: '@claude 主持，暂停测试', chat_id: id });
  await until(async () => (await init()).messages.some(m => m.text.startsWith('⏸ 主持人暂停了比赛')));
  await new Promise(r => setTimeout(r, 500));
  assert.equal(turns().length, 1);                                                    // nobody plays while paused
  assert.equal((await init()).state.game.ledger, '账本 A');
  await post('/api/send', { text: '程序修好了吗？', chat_id: id });
  const s = await until(async () => { const x = await init(); return x.state.game?.over && x; });
  assert.equal(s.state.game.ledger, '账本 B');
  assert.ok(turns()[1].h === 'claude' && turns()[1].p.includes('程序修好了吗？'));     // the host is woken with the user's message
});

test('saved prompts: kept on the server with their mode, same title replaced, deleted; never sent to a shared link', async t => {
  const { post, init, url } = await server(t);
  assert.equal((await post('/api/prompts/save', { title: '', text: 'x' })).status, 500);
  await post('/api/prompts/save', { title: '密封竞拍', text: '@glm 主持，玩密封竞拍 v1', mode: 'game' });
  await post('/api/prompts/save', { title: '研究模板', text: '先查事实', mode: 'auto' });
  await post('/api/prompts/save', { title: '密封竞拍', text: '@glm 主持，玩密封竞拍 v2', mode: 'game' });
  let ps = (await init()).prompts;
  assert.deepEqual(ps.map(p => [p.title, p.text, p.mode]), [['密封竞拍', '@glm 主持，玩密封竞拍 v2', 'game'], ['研究模板', '先查事实', null]]);
  await post('/api/prompts/delete', { id: ps[1].id });
  ps = (await init()).prompts;
  assert.deepEqual(ps.map(p => p.title), ['密封竞拍']);
  const { id } = await (await post('/api/chat/new')).json();                     // "新讨论" gets the new discussion's id
  assert.equal((await init()).state.chatId, id);
  const { share } = await (await post('/api/chat/share', { id })).json();
  const rd = (await fetch(`${url}/events?s=${share}`)).body.getReader();
  const first = new TextDecoder().decode((await rd.read()).value);
  rd.cancel();
  assert.ok(!first.includes('密封竞拍'));
});

test('game: the user can end a game the host never ended; the next message is free talk', async t => {
  const { post, init, until, turns } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'game' });
  await post('/api/send', { text: '@claude 主持，暂停测试', chat_id: id });
  await until(async () => (await init()).messages.some(m => m.text.startsWith('⏸')));
  await post('/api/game/end');
  assert.equal((await init()).state.game.over, 'user');
  await post('/api/send', { text: '聊聊刚才那局', chat_id: id });
  await until(async () => (await init()).messages.some(m => m.kind === 'agent' && m.text.endsWith('发言。')));
  assert.ok(!turns().slice(1).some(x => x.p.includes('You are the HOST')));          // no host turn after the end
});

test('game: another game in the same discussion after one is over; the finished one is kept', async t => {
  const { post, init, until, turns } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'game' });
  await post('/api/game/new');                                                    // nothing to restart yet
  await post('/api/send', { text: '@claude 主持，我们玩个猜数游戏', chat_id: id });
  await until(async () => (await init()).state.game?.over);
  await post('/api/game/new');
  assert.equal((await init()).state.game, undefined);
  await until(async () => (await init()).messages.some(m => m.text.startsWith('🎲 再开一局（这个讨论的第 2 局')));
  const n = turns().filter(x => x.p.includes('You are the HOST')).length;
  await post('/api/send', { text: '@codex 主持，再来一局', chat_id: id });
  const s = await until(async () => { const x = await init(); return x.state.game?.over && x.state.game.host === 'codex' && x; });
  const host = turns().filter(x => x.p.includes('You are the HOST')).slice(n);
  assert.ok(host[0].h === 'codex' && host[0].p.includes('This is your first turn'));
  assert.ok(s.state.game.players.includes('claude'));
});

test('game: the user leaves while the host plays its turn; its notes stay in the game, which carries on when the user is back', async t => {
  const { post, init, until, turns } = await server(t, 1);                        // the host's first turn is slow
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'game' });
  await post('/api/send', { text: '@claude 主持，我们玩个猜数游戏', chat_id: id });
  await until(async () => turns().length >= 1);
  await post('/api/chat/new');                                                    // away while the host thinks
  await new Promise(r => setTimeout(r, 5500));                                   // the host's turn ends meanwhile
  assert.equal(turns().length, 1);                                               // nothing plays in a discussion nobody is in
  assert.ok(!(await init()).messages.some(m => m.text.startsWith('🎲')));         // the game's note isn't here
  await post('/api/chat/switch', { id });
  const s = await until(async () => { const x = await init(); return x.state.game?.over && x; });
  assert.ok(s.messages.some(m => m.text === '🎲 轮流发言：@opencode → @agy。'));
});

test('names: a member names itself with [NAME], shown on its messages; @name reaches it, a former name too; clashes refused', async t => {
  const { post, init, until, turns } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'roundtable' });
  await post('/api/send', { text: '取名测试：各自介绍一下', chat_id: id });
  let s = await until(async () => { const x = await init(); return x.messages.filter(m => m.kind === 'agent').length >= 4 && x; });
  const fox = s.messages.find(m => m.sender === 'claude');
  assert.deepEqual([fox.text, fox.nick], ['我是老狐狸。', '老狐狸']);
  assert.equal(s.messages.find(m => m.sender === 'codex').nick, null);                    // too close to @claude: refused
  assert.ok(s.messages.some(m => m.kind === 'moderator' && m.text === '🏷 @claude 给自己取名「老狐狸」'));
  assert.equal(s.state.members.find(m => m.name === 'claude').nick, '老狐狸');           // kept with a [NOTE] in the same reply
  assert.deepEqual(s.state.notes.map(x => x.text), ['狐狸登场']);

  const n = turns().length;
  await post('/api/send', { text: '@老狐狸 改名吧', chat_id: id });                        // @name reaches its member
  await until(async () => (await init()).messages.some(m => m.text.includes('改成「黑猫」')));
  assert.deepEqual(turns().slice(n).map(x => x.h), ['claude']);
  s = await init();
  assert.equal(s.messages.filter(m => m.sender === 'claude').at(-1).nick, '黑猫');
  assert.equal(fox.nick, s.messages.find(m => m.id === fox.id).nick);                     // the old message keeps its name

  const k = turns().length;
  await post('/api/send', { text: '@老狐狸 还在吗', chat_id: id });                        // a former name still works
  await until(async () => turns().length > k);
  assert.equal(turns()[k].h, 'claude');
  assert.ok(turns()[k].p.includes('called 「黑猫」 here'));                                 // the roster carries the name

  const j = turns().length;
  await post('/api/send', { text: '@codex 你呢', chat_id: id });
  await until(async () => turns().length > j);
  assert.ok(turns()[j].h === 'codex' && turns()[j].p.includes('Your name "claude2" was not taken'));
});

test('deleting the newest discussion: its ids are not reused, so a new discussion is not taken as already wrapped up', async t => {
  const { post, init, until } = await server(t);
  await post('/api/settings', { turnCap: 2 });
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'roundtable' });
  await post('/api/send', { text: '第一个问题', chat_id: id });
  await until(async () => (await init()).messages.some(m => m.kind === 'agent'));
  await post('/api/stop');                                   // the round is wrapped up (kept by its user message id)
  const old = Math.max(...(await init()).messages.map(m => m.id));
  await post('/api/chat/delete', { id });
  const { id: id2 } = await (await post('/api/chat/new')).json();
  assert.ok(id2 > id);
  await post('/api/chat/mode', { id: id2, mode: 'roundtable' });
  await post('/api/send', { text: '第二个问题', chat_id: id2 });
  const s = await until(async () => { const x = await init(); return x.messages.some(m => m.kind === 'agent') && x; });
  assert.ok(s.messages.every(m => m.id > old));
  assert.equal(s.state.wrapped, false);
});

test('members attach files from the workspaces and have avatars', async t => {
  const { post, init, until, url, turns } = await server(t);
  await post('/api/send', { text: '附件测试 @claude' });
  const m = await until(async () => (await init()).messages.find(x => x.sender === 'claude'));
  assert.equal(m.text, '画好了。');
  const fs = JSON.parse(m.files);
  assert.deepEqual(fs.map(f => [f.name, f.type, f.size]), [['pic.png', 'image/png', 3]]); // nothing from outside the workspaces
  assert.equal(await (await fetch(`${url}/files/${fs[0].file}`)).text(), 'png');
  assert.equal(await (await fetch(`${url}/avatar/claude`)).text(), 'av');
  assert.equal((await fetch(`${url}/avatar/codex`)).status, 404);
  assert.ok((await init()).state.members.find(x => x.name === 'claude').avatar > 0);
  assert.ok(turns()[0].p.includes('avatar.png'));
});

test('restart: replies written but not yet published survive it, and nobody is asked again', async t => {
  const { post, init, until, turns, restart } = await server(t);
  const id = (await init()).state.chatId;
  await post('/api/chat/mode', { id, mode: 'roundtable' });
  await post('/api/send', { text: '重启测试：午饭吃什么？', chat_id: id });
  await post('/api/typing', { typing: true }); // the user types again: the queue holds
  for (let i = 0; i < 300 && (await init()).state.queue.length < 4; i++) await new Promise(r => setTimeout(r, 30));
  let s = await init();
  assert.equal(s.state.queue.length, 4);
  assert.equal(s.messages.filter(m => m.kind === 'agent').length, 0);
  await restart();
  s = await until(async () => { const x = await init(); return x.messages.filter(m => m.kind === 'agent').length >= 4 && x; });
  assert.deepEqual(s.messages.filter(m => m.kind === 'agent').map(m => m.sender).sort(), ['agy', 'claude', 'codex', 'opencode']);
  assert.equal(s.state.queue.length, 0);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(turns().length, 4); // their sessions had already moved past these replies
});

test('a reply finished after the user switched discussions goes to its own discussion, not the open one', async t => {
  const { post, init, until, turns, url } = await server(t, 4); // the four opening turns take 5 s
  const a = (await init()).state.chatId;
  await post('/api/chat/mode', { id: a, mode: 'roundtable' });
  await post('/api/send', { text: '切换测试：周末去哪？', chat_id: a });
  await until(async () => turns().length >= 4);
  const { id: b } = await (await post('/api/chat/new')).json();
  assert.notEqual(a, b);
  const exported = () => fetch(`${url}/api/export?id=${a}`).then(r => r.text());
  await until(async () => ((await exported()).match(/发言。/g) || []).length >= 4);
  const s = await init();
  assert.equal(s.state.chatId, b);
  assert.equal(s.messages.length, 0);       // nothing leaked into the open discussion
  assert.equal(s.state.queue.length, 0);
  // the user's message in b gets its own round
  await post('/api/send', { text: '新话题', chat_id: b });
  await until(async () => (await init()).messages.filter(m => m.kind === 'agent').length >= 4);
});
