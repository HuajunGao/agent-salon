// Discussions: which one is current (and whether it is paused), each one's persistent state (chats.state: notes,
// debate, game, names, arena, outsider), its mode and rules, its messages (who may see which), the archive, and the
// decision log. The only module that writes chats and messages.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODES, rulesOf } from './modes.mjs';
import { memberMentions } from './members.mjs';
import { q, q1, run } from './db.mjs';
import { ARCHIVE, UPLOADS } from './workspace.mjs';
import { S, NAMES, memberConfigs, tx, atOf, aliasOf, modelOf } from './config.mjs';
import { send, sendViewers } from './sse.mjs';

// ---------- the current discussion ----------
// One discussion is current for the whole server (every window shows it). paused is stored per discussion;
// circlePaused: the pause is the moderator's (the discussion was circling), so the user's next message lifts it.
export let chatId = q1('SELECT max(id) id FROM chats')?.id || Number(run(`INSERT INTO chats(title) VALUES(?)`, tx('讨论 {n}', { n: 1 })).lastInsertRowid);
export let paused = !!q1('SELECT paused FROM chats WHERE id=?', chatId).paused;
export let circlePaused = false;
export function setCurrent(id) {
  chatId = id; paused = !!q1('SELECT paused FROM chats WHERE id=?', id).paused; circlePaused = false;
}
export function setPaused(p, byModerator = false) {
  paused = !!p; circlePaused = paused && byModerator;
  run('UPDATE chats SET paused=? WHERE id=?', +paused, chatId);
}
// The user set a direction (or an outsider brought one): a circling pause ends.
export const endCirclePause = () => void (circlePaused && setPaused(false));
export const chatExists = c => !!q1('SELECT 1 FROM chats WHERE id=?', c);
export const newChat = title => Number(run('INSERT INTO chats(title) VALUES(?)', title).lastInsertRowid);
export const maxChat = () => q1('SELECT coalesce(max(id),0) m FROM chats').m;

// ---------- per-discussion state, mode and rules ----------
export const chatState = c => JSON.parse(q1('SELECT state FROM chats WHERE id=?', c)?.state || '{}');
export const saveState = (c, st) => run('UPDATE chats SET state=? WHERE id=?', JSON.stringify(st), c);
export const FALLBACK_MODE = 'roundtable'; // while Auto has no classification yet (or Jev failed)
export const chatMode = c => {
  const r = q1('SELECT mode, auto_mode FROM chats WHERE id=?', c) || {};
  const mode = MODES[r.mode] ? r.mode : 'auto';
  return { mode, auto: MODES[r.auto_mode] ? r.auto_mode : null, effective: mode === 'auto' ? (MODES[r.auto_mode] ? r.auto_mode : FALLBACK_MODE) : mode };
};
// The rules in force: the mode's, except that a finished debate continues as free discussion.
export const rules = c => rulesOf(chatMode(c).effective, chatState(c).debate);

export const sess = (c, a) => q1('SELECT * FROM agent_sessions WHERE chat_id=? AND agent=?', c, a)
  || (run('INSERT INTO agent_sessions(chat_id, agent) VALUES(?,?)', c, a), sess(c, a));
export const maxId = c => q1('SELECT coalesce(max(id),0) m FROM messages WHERE chat_id=?', c).m;
export const lastUserId = c => q1(`SELECT coalesce(max(id),0) m FROM messages WHERE chat_id=? AND kind='user' AND dm IS NULL`, c).m;
// Only user and agent messages are the discussion; system/moderator notes are for the UI. Private messages (dm) are not
// part of it: not archived, not judged by Jev, shown only to their sender and addressee (HEARS, bound to the member twice).
export const TALK = `kind IN ('user','agent') AND dm IS NULL`;
export const HEARS = `kind IN ('user','agent') AND (dm IS NULL OR dm=? OR sender=?)`;
// What a member's chat session hasn't written itself: others' messages, and an outsider report sent under its name.
export const UNSEEN = `(sender<>? OR coalesce(role,'')='outsider')`;
export const lastTalkId = (c = chatId) => q1(`SELECT coalesce(max(id),0) m FROM messages WHERE chat_id=? AND ${TALK}`, c).m;
export const turnsSinceUser = (a, c = chatId) => q1('SELECT count(*) n FROM messages WHERE chat_id=? AND sender=? AND id>?', c, a, lastUserId(c)).n;

export function logDecision(event, agent, extra = {}) {
  run('INSERT INTO decisions(chat_id, mode, event, agent, score, detail, based_on, message_id, latency_ms) VALUES(?,?,?,?,?,?,?,?,?)',
    extra.chat ?? chatId, S.scheduler, event, agent ?? null, extra.score ?? null, extra.detail ? JSON.stringify(extra.detail) : null,
    extra.based_on ?? null, extra.message_id ?? null, extra.latency_ms ?? null);
}

// ---------- names the members give themselves ([NAME]) ----------
// Per discussion, in chats.state.names: {member: [current, ...former]}. Only a way to address a member: everything the
// server keeps (hands, game players, DM addressees, orders) uses the handle, so renames can't break anything; former names
// still reach their member and nobody else may take them. At most NICK_MAX names per member and discussion.
const NICK_MAX = 6;
export const nickOf = (a, c = chatId) => (chatState(c).names || {})[a]?.[0] || null;
export function setNick(c, a, nick) {
  const st = chatState(c), names = st.names ??= {}, mine = names[a] ??= [], low = nick.toLowerCase();
  if (mine[0] === nick) return null;
  if (!/^[^\s@#\[\]()（）「」<>]{1,12}$/u.test(nick)) return 'a name is 1-12 characters, without spaces, @, # or brackets';
  // taken: another member's handle, @-name or any of its names, or one is a prefix of the other (@老狐 would also match @老狐狸)
  const clash = n => { n = String(n || '').toLowerCase(); return n && (n.startsWith(low) || low.startsWith(n)); };
  const other = NAMES.find(n => n !== a && [n, atOf(n), memberConfigs[n].label, ...names[n] || []].some(clash));
  if (other) return `it is too close to @${atOf(other)}'s name`;
  if (!mine.includes(nick) && mine.length >= NICK_MAX) return `you already used ${NICK_MAX} names in this discussion`;
  names[a] = [nick, ...mine.filter(x => x !== nick)];
  saveState(c, st);
  return null;
}
export const mentions = (text, c = chatId) => { const names = chatState(c).names || {};
  return memberMentions(text, NAMES, Object.fromEntries(NAMES.map(n => [n, [memberConfigs[n].label, ...names[n] || []]]))); };
// A private message's addressee: a member (handle or name), or the user (@user, or the name set under 关于你).
export const dmTo = t => (/^(user|用户)$/i.test(t) || (S.userName && t === S.userName) ? 'user' : mentions(`@${t}`)[0]);

// ---------- how messages read in prompts and the archive ----------
export const who = s => (s === 'user' ? '用户 (user)' : memberConfigs[s] ? `@${atOf(s)}` : `@${s}`);
export const describe = a => `@${atOf(a)}${nickOf(a) ? ` called 「${nickOf(a)}」 here` : ''} (${aliasOf(a)}, ${memberConfigs[a].harness} running ${modelOf(a)})`;
// Members (and Jev) see each other's stated stance and confidence, as in ReConcile's round table.
export const withStance = m => { const st = m.stance && JSON.parse(m.stance);
  return st ? `${m.text}\n[STANCE ${st.c}%] ${st.t}` : m.text; };
export const attached = m => { const fs = m.files && JSON.parse(m.files);
  return fs?.length ? `\n(Attached: ${fs.map(f => `${join(UPLOADS, f.file)} (${f.name}, ${f.type || 'file'}, ${Math.ceil(f.size / 1024)} KB)`).join('; ')})` : ''; };
export const fmt = m => `#${m.id} ${who(m.sender)}${m.nick ? `「${m.nick}」` : ''}${m.dm ? ` → ${who(m.dm)} (${m.role === 'order' ? 'secret order' : 'private message'})` : ''}${m.role === 'outsider' ? ' (outsider: a fresh session of this model that thought it through before reading the discussion)' : ''}${m.reply_to ? ` (回复 #${m.reply_to})` : ''}: ${withStance(m)}${attached(m)}`;

// ---------- messages: stored, archived, shown to whoever may see them ----------
// The user plays a game (setting userPlays when it started): until it is over the UI gets no private message or secret
// order between others, no host ledger and no live output (it shows DMs being written); afterwards everything.
export const userPlays = c => { const g = chatState(c).game; return !!(g?.host && g.user && !g.over); };
export const secret = m => !!m.dm && m.dm !== 'user' && m.sender !== 'user';
export const visible = (c, msgs) => (userPlays(c) ? msgs.filter(m => !secret(m)) : msgs);
export const chatMessages = c => visible(c, q('SELECT * FROM messages WHERE chat_id=? ORDER BY id', c));
export function insertMsg(m) {
  const id = Number(run(`INSERT INTO messages(chat_id, sender, kind, text, based_on, reply_to, latency_ms, turn_no, stale, model, role, mode, stance, seat, note_ops, files, dm, nick)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, m.chat_id, m.sender, m.kind, m.text, m.based_on ?? null, m.reply_to ?? null,
    m.latency_ms ?? null, m.turn_no ?? null, m.stale ? 1 : 0, m.model ?? null, m.role ?? null, m.mode ?? null,
    m.stance ? JSON.stringify(m.stance) : null, m.seat ?? null, m.note_ops ?? null, m.files?.length ? JSON.stringify(m.files) : null, m.dm ?? null, m.nick ?? null).lastInsertRowid);
  const msg = q1('SELECT * FROM messages WHERE id=?', id);
  archiveSoon(m.chat_id);
  if (secret(msg) && userPlays(m.chat_id)) return msg;
  if (m.chat_id === chatId) send({ type: 'msg', msg });
  sendViewers(m.chat_id, { type: 'msg', msg });
  return msg;
}
// A moderator note (🧭, ⚠, ▶ …): shown in the UI, never sent to the members or Jev.
export const note = (text, c = chatId) => insertMsg({ chat_id: c, sender: 'moderator', kind: 'moderator', text });

// ---------- the archive members can read: data/discussions/<id>.md and index.md ----------
export const archiveFile = c => join(ARCHIVE, `${c}.md`);
function writeTranscript(c) {
  const chat = q1('SELECT title, created_at FROM chats WHERE id=?', c);
  if (!chat) return;
  writeFileSync(archiveFile(c), `# ${chat.title}\n\n讨论 ${c}，开始于 ${chat.created_at} UTC\n\n`
    + q(`SELECT * FROM messages WHERE chat_id=? AND ${TALK} ORDER BY id`, c).map(fmt).join('\n\n') + '\n');
}
// One line per discussion: when, size, the question and (if the moderator wrapped it up) the latest summary.
export function writeIndex() {
  const rows = q(`SELECT c.id, c.title, c.created_at,
      (SELECT count(*) FROM messages WHERE chat_id=c.id AND ${TALK}) n,
      (SELECT text FROM messages WHERE chat_id=c.id AND kind='user' ORDER BY id LIMIT 1) q,
      (SELECT text FROM messages WHERE chat_id=c.id AND role='summary' ORDER BY id DESC LIMIT 1) s
    FROM chats c ORDER BY c.id DESC`);
  const one = t => (t || '').replace(/\s+/g, ' ').slice(0, 300);
  writeFileSync(join(ARCHIVE, 'index.md'), '# 往期讨论\n\n每场讨论的全文在同目录的 <编号>.md。\n\n' + rows.map(r =>
    `- 讨论 ${r.id}「${r.title}」${r.created_at.slice(0, 10)}，${r.n} 条消息。问题：${one(r.q)}${r.s ? `\n  结论：${one(r.s)}` : ''}`).join('\n') + '\n');
}
// Rewriting a whole discussion and the index on every message blocked the server for long discussions: writes are
// batched (a reply with several DMs is one write). A restart rewrites everything, so nothing pending is lost.
const dirty = new Set();
let archiveTimer;
export function archiveSoon(c) {
  dirty.add(c);
  archiveTimer ??= setTimeout(flushArchive, 300);
}
export function flushArchive() {
  clearTimeout(archiveTimer); archiveTimer = null;
  for (const c of dirty) writeTranscript(c);
  dirty.clear();
  writeIndex();
}
