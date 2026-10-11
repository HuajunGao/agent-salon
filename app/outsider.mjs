// ---------- outsider: a fresh look from someone who hasn't read the discussion ----------
// Groups anchor, and so does a moderator that reads everything: once the members spent days on a wall that
// each of their own models, asked cold with only the problem and the source code, saw past in minutes. So one member,
// rotating, gets a fresh read-only CLI session with only the user's own messages and the shared files; it thinks first,
// then reads the archive and reports only what the group hasn't tried. Its report is a candidate, not a conclusion.
// Triggered every OUTSIDER_EVERY members' messages (a dumb watchdog: whoever is stuck doesn't know it), when Jev sees
// the discussion circling (not sooner than OUTSIDER_COOLDOWN messages after the last one), or by the user.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runTurn } from './agents.mjs';
import { q, q1 } from './db.mjs';
import { DATA, WORK, SHARED, ARCHIVE, own } from './workspace.mjs';
import { S, NAMES, memberConfigs, atOf, memberAt, tx, replyLang, fileCapable } from './config.mjs';
import { chatId, chatState, saveState, chatMode, rules, lastUserId, maxId, logDecision, insertMsg, note, attached, archiveFile, endCirclePause } from './chats.mjs';
import { raise, pump, wrapped } from './runtime.mjs';
import { shellRule } from './prompts.mjs';

const OUTSIDER_EVERY = 40, OUTSIDER_COOLDOWN = 15; // ponytail: message-count trigger, tune once outsider-end decisions show when reports helped
const outsiders = new Set(); // chats with an outsider at work
export function maybeOutsider(why) {
  const c = chatId;
  if (!S.outsider || outsiders.has(c) || !rules(c).moderated || !lastUserId(c)) return false;
  const n = q1(`SELECT count(*) n FROM messages WHERE chat_id=? AND kind='agent' AND id>?`, c, chatState(c).outsider?.at || lastUserId(c)).n; // never had one: count from the user's latest message
  return n >= (why === 'watchdog' ? OUTSIDER_EVERY : OUTSIDER_COOLDOWN) && startOutsider(c, why);
}
export function startOutsider(c, why) {
  if (outsiders.has(c)) return false;
  const st = chatState(c), by = st.outsider?.by || {};
  // The member who has been the outsider least, then the one least involved lately.
  const recent = q(`SELECT sender FROM messages WHERE chat_id=? AND kind='agent' ORDER BY id DESC LIMIT 40`, c).map(m => m.sender);
  const a = NAMES.filter(n => S.enabled[n] && fileCapable(n))
    .map(n => [n, by[n] || 0, recent.filter(s => s === n).length, Math.random()])
    .sort((x, y) => x[1] - y[1] || x[2] - y[2] || x[3] - y[3])[0]?.[0];
  if (!a) return false;
  st.outsider = { at: maxId(c), by: { ...by, [a]: (by[a] || 0) + 1 } };
  saveState(c, st);
  outsiders.add(c);
  const cwd = join(WORK, '_outsider', `${c}-${st.outsider.at}`);
  mkdirSync(cwd, { recursive: true }); own(cwd);
  logDecision('outsider-start', a, { message_id: st.outsider.at, detail: { why } });
  note(`🧭 ${why === 'circling' ? tx('讨论在原地打转，') : ''}`
    + tx('请 @{a} 当局外人：用它的模型开一个新会话，只看你的提问和共享文件，先独立想，再读讨论记录，只带回没试过的方向。', { a: atOf(a) }), c);
  runOutsider(a, c, cwd).catch(e => ({ error: e.message, ms: 0 })).then(r => {
    outsiders.delete(c);
    logDecision('outsider-end', a, { message_id: st.outsider.at, latency_ms: r.ms, detail: { why, error: r.error || null, chars: r.text?.length || 0 } });
    const none = /^NOTHING NEW[.。]?$/i.test(r.text || '');
    if (r.error || none || !r.text) return void note(r.error ? tx('⚠ 局外人 @{a} 出错：{err}', { a: memberAt(a), err: r.error.slice(0, 120) })
      : tx('🧭 局外人 @{a} 没发现群里没试过的方向。', { a: memberAt(a) }), c);
    insertMsg({ chat_id: c, sender: a, kind: 'agent', text: r.text, based_on: st.outsider.at, latency_ms: r.ms,
      model: S.models[a] || 'default', role: 'outsider', mode: chatMode(c).effective });
    if (c !== chatId || wrapped(c)) return;
    endCirclePause();
    for (const n of NAMES) raise(n, 1.5, 'outsider');
    pump();
  });
  return true;
}
async function runOutsider(a, c, cwd) {
  const asks = q(`SELECT * FROM messages WHERE chat_id=? AND kind='user' ORDER BY id DESC LIMIT 6`, c).reverse()
    .map(m => `- ${m.text}${attached(m)}`).join('\n');
  const opts = { cwd, dataDir: DATA, model: S.models[a], exec: false, member: { ...memberConfigs[a], model: S.models[a] },
    onLive() {}, idleMs: 10 * 60e3, totalMs: 25 * 60e3 };
  const t0 = Date.now(), lang = replyLang();
  const one = await runTurn(memberConfigs[a].harness, `You are an outside expert, called in fresh. A group of AI agents has
been working on the user's problem for a while. You have not seen their discussion, on purpose: groups anchor on their
first ideas, and a fresh look often finds what they missed.

The user's own messages, the newest last (the problem the group works on now is usually in the latest ones):
${asks}

The group's shared files (code, tools, data) are in ${SHARED}; read source code and documentation there and anywhere
else on disk as you need. Don't read the discussion archive (${ARCHIVE}) yet, nor notes, logs or result files where the
group wrote down its conclusions: work from the problem and the sources. Don't create, edit or delete files. ${shellRule(a)}

Find the 3 to 5 most promising ways to get what the user is after now. Don't assume the obvious approach is right. For
each: the concrete fact it rests on (file:line where it applies), how to do it, how to check it worked. Be brief.`, null, opts);
  if (one.error || !one.sid) return { error: one.error || 'no session', ms: Date.now() - t0 };
  const two = await runTurn(memberConfigs[a].harness, `Now read what the group has done: the discussion is archived in
${archiveFile(c)} (long: search it for your ideas' keywords and read its last 100 messages). For each of your ideas, did
the group already try or discuss it (cite #N)? Keep only the ideas that are new to them, or that they dropped for a
reason you can show is wrong.

Then write the message the group will read, in ${lang}, under 300 words (or 500 Chinese characters): each kept idea with
the fact it rests on and how to check it. Present them as candidates to test, not conclusions. No [HAND], [NOTE],
[STANCE], [JOB] or [TASK] markers. If nothing is new, answer exactly NOTHING NEW.`, one.sid, opts);
  return { text: (two.text || '').trim(), error: two.error, ms: Date.now() - t0 };
}
