import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberMentions, providerConfig, validateMember, atToken } from './members.mjs';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

test('mentions follow configured identities, never assume a harness or model name', () => {
  assert.deepEqual(memberMentions('@GPT @glm @gpt @opencode @unknown @gpt_extra', ['gpt', 'glm']), ['gpt', 'glm']);
  assert.deepEqual(memberMentions('@opencode @researcher', ['opencode', 'researcher']), ['opencode', 'researcher']);
  assert.deepEqual(memberMentions('@glm', []), []);
  // aliases count too, in text order; an alias is matched whole (CJK text may follow it)
  assert.deepEqual(memberMentions('@小智你看 @GPT6 和 @claude', ['claude', 'codex', 'agy'], { codex: 'gpt6', agy: '小智' }), ['agy', 'codex', 'claude']);
  assert.deepEqual(memberMentions('@gpt6x @gpt6-1', ['codex'], { codex: 'gpt6' }), []);
  assert.equal(atToken('codex', 'gpt'), 'gpt');
  assert.equal(atToken('codex', 'GPT 6'), 'codex');
  assert.equal(atToken('codex', ''), 'codex');
});
test('member validation preserves, replaces and clears credentials', () => {
  const body = { name: 'gpt', model: 'openai/example', baseURL: 'https://example.com/v1' };
  assert.equal(validateMember(body, { apiKey: 'secret' }).apiKey, 'secret');
  assert.equal(validateMember({ ...body, apiKey: 'new' }, { apiKey: 'secret' }).apiKey, 'new');
  assert.equal(validateMember({ ...body, clearKey: true }, { apiKey: 'secret' }).apiKey, '');
  for (const name of ['user', 'system', 'moderator', '../escape', '__proto__'])
    assert.throws(() => validateMember({ ...body, name }));
  assert.throws(() => validateMember({ ...body, baseURL: 'file:///tmp/a' }));
  assert.throws(() => validateMember({ ...body, model: 'no-provider' }));
});
test('OpenCode v1 and v2 receive per-member providers without embedding credentials', () => {
  const a = validateMember({ name: 'gpt', model: 'openai/example', apiKey: 'secret', baseURL: 'https://a.example/v1' });
  const b = validateMember({ name: 'reviewer', model: 'proxy/other', apiKey: 'other-secret', baseURL: 'https://b.example/v1', protocol: 'chat' });
  assert.equal(providerConfig(a, false).provider.openai.npm, '@ai-sdk/openai');
  assert.equal(providerConfig(b, false).provider.proxy.npm, '@ai-sdk/openai-compatible');
  assert.equal(providerConfig(a, true).providers.openai.package, '@opencode/ai/providers/openai-compatible/responses');
  assert.equal(providerConfig(b, true).providers.proxy.settings.baseURL, b.baseURL);
  assert.ok(!JSON.stringify(providerConfig(a, true)).includes('secret'));
  assert.deepEqual(providerConfig({ model: 'openai/example' }, true), {});
});

test('HTTP member lifecycle persists, keeps credentials private and routes @handles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-chat-member-test-'));
  const app = join(root, 'app'); mkdirSync(app);
  for (const f of ['server.mjs', 'members.mjs', 'modes.mjs', 'game.mjs', 'moderator.mjs', 'memory.mjs', 'speech.mjs', 'index.html'])
    copyFileSync(fileURLToPath(new URL(f, import.meta.url)), join(app, f));
  // Exercise the actual server and SQLite with a deterministic harness, without calling paid models.
  writeFileSync(join(app, 'agents.mjs'), `export { AGENTS, runAs, spawnJob } from ${JSON.stringify(new URL('agents.mjs', import.meta.url).href)};
    import {writeFileSync} from 'node:fs';
    export async function listModels(){return {opencode:[]}};
    export async function runTurn(h,p,s,o){writeFileSync(${JSON.stringify(join(root,'turn.json'))},JSON.stringify({h,p,model:o.model}));return {text:'PASS', sid:s || o.member.name+'-session', ms:1}};`);
  const portServer = net.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise(r => portServer.close(r));
  const url = `http://127.0.0.1:${port}`;
  let child;
  let diagnostics = '';
  const boot = async () => {
    diagnostics = '';
    child = spawn(process.execPath, [join(app, 'server.mjs')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_USER: '', TYPESAFE_API_KEY: '' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', d => { diagnostics += d; });
    let fetchError;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url)).ok) return; } catch (e) { fetchError = e.cause || e; }
      await new Promise(r => setTimeout(r, 30));
    }
    throw new Error('Test server did not start: ' + diagnostics + ' exit=' + child.exitCode + ' fetch=' + fetchError);
  };
  const stop = async () => { if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed; } };
  const post = async (route, body = {}) => {
    const r = await fetch(url + route, { method: 'POST', body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const state = async () => {
    const controller = new AbortController();
    const r = await fetch(url + '/events', { signal: controller.signal });
    const reader = r.body.getReader(); let s = '';
    while (!s.includes('\n\n')) s += new TextDecoder().decode((await reader.read()).value);
    controller.abort(); return JSON.parse(s.split('\n\n')[0].slice(6));
  };
  try {
    await boot(); await post('/api/pause', { paused: true });
    await post('/api/settings', { memory: false, autoStop: false, devil: false, circlePause: false });
    const body = { name: 'gpt', label: 'GPT', model: 'openai/test', apiKey: 'secret-test-key', baseURL: 'https://example.com/v1' };
    assert.equal((await post('/api/member/save', body)).status, 200);
    assert.equal((await post('/api/member/save', { ...body, name: 'reviewer', label: 'Reviewer', model: 'proxy/other' })).status, 200);
    let s = await state();
    assert.equal(s.state.members.find(m => m.name === 'gpt').config.hasKey, true);
    assert.ok(!JSON.stringify(s).includes(body.apiKey));
    assert.equal((await post('/api/send', { text: '@gpt hello' })).status, 200);
    s = await state(); assert.equal(s.state.members.find(m => m.name === 'gpt').hand.r, 10);
    assert.equal(s.state.members.find(m => m.name === 'reviewer').hand, null);
    await post('/api/lower', { agent: 'gpt' });
    await post('/api/pause', { paused: false });
    await post('/api/floor', { agent: 'gpt' });
    for (let i = 0; i < 40; i++) {
      s = await state(); if (s.state.members.find(m => m.name === 'gpt').sid) break;
      await new Promise(r => setTimeout(r, 30));
    }
    assert.equal(s.state.members.find(m => m.name === 'gpt').sid, 'gpt-session');
    assert.equal(s.state.members.find(m => m.name === 'reviewer').sid, null);
    const turn = JSON.parse(readFileSync(join(root, 'turn.json'), 'utf8'));
    assert.equal(turn.h, 'opencode');
    assert.equal(turn.model, 'openai/test');
    assert.ok(turn.p.includes('Current participating members (6):'));
    assert.ok(turn.p.includes('@Reviewer'));
    assert.ok(!turn.p.includes('glm-5.3'));
    assert.equal((await post('/api/member/alias', { name: 'gpt', label: '小智' })).status, 200);
    s = await state();
    assert.equal(s.state.members.find(m => m.name === 'gpt').label, '小智');
    assert.equal(s.state.members.find(m => m.name === 'gpt').sid, 'gpt-session');
    assert.equal((await post('/api/member/alias', { name: 'gpt', label: '' })).status, 200);
    assert.equal((await state()).state.members.find(m => m.name === 'gpt').label, 'gpt');
    assert.equal((await post('/api/member/alias', { name: 'claude', label: '审稿人' })).status, 200);
    assert.equal((await state()).state.members.find(m => m.name === 'claude').label, '审稿人');
    assert.equal((await state()).state.members.find(m => m.name === 'claude').at, '审稿人');
    assert.equal((await post('/api/member/alias', { name: 'gpt', label: '审稿人' })).status, 500); // claude's @-name
    assert.equal((await post('/api/member/alias', { name: 'gpt', label: 'Claude' })).status, 500); // claude's handle
    await post('/api/pause', { paused: true });
    assert.equal((await post('/api/member/save', { ...body, apiKey: '', label: 'GPT edited' })).status, 200);
    assert.equal((await state()).state.members.find(m => m.name === 'gpt').sid, null);
    assert.equal((await post('/api/member/save', { ...body, name: 'user' })).status, 500);
    assert.equal((await post('/api/member/delete', { name: 'reviewer' })).status, 200);
    const order = (await state()).state.members.map(m => m.name).reverse();
    assert.equal((await post('/api/member/order', { names: order })).status, 200);
    assert.deepEqual((await state()).state.members.map(m => m.name), order);
    assert.equal((await post('/api/member/order', { names: ['gpt', 'gpt'] })).status, 500);
    await stop(); await boot();
    s = await state();
    assert.deepEqual(s.state.members.map(m => m.name), order);
    assert.equal(s.state.members.find(m => m.name === 'gpt').label, 'GPT edited');
    assert.equal(s.state.members.find(m => m.name === 'gpt').config.hasKey, true);
    assert.ok(!s.state.members.some(m => m.name === 'reviewer'));
    assert.ok(!JSON.stringify(s).includes(body.apiKey));
  } finally { await stop(); rmSync(root, { recursive: true, force: true }); }
});
