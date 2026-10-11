// The room's in-memory state: each member's turn status and raised hand, the replies waiting to be published, the
// reading-pace clocks. The reply queue (and the notes held behind it) is saved, so a restart doesn't lose replies
// already written: by then the member's CLI session has moved past them.
import { getSetting, setSetting } from './db.mjs';
import { NAMES, S } from './config.mjs';
import { chatId, chatExists, note, lastUserId } from './chats.mjs';

// hand: {r: relevance, since, why}; r >= 100 means the user gave the floor (bypasses cap and "nothing new").
// jobs: what the member hasn't been told yet (finished jobs and tasks, refused names …), for its next turn there.
const fresh = () => ({ status: 'idle', started: 0, live: '', hand: null, note: '', error: '' });
export const rt = Object.fromEntries(NAMES.map(n => [n, fresh()]));
export const addMember = a => { rt[a] = fresh(); };
export const removeMember = a => { delete rt[a]; };
export const tell = (a, item) => void (rt[a] && (rt[a].jobs ??= []).push(item));

export function raise(a, r, why) {
  if (!S.enabled[a]) return;
  const h = rt[a].hand;
  rt[a].hand = { r: Math.max(r, h?.r || 0), since: h?.since || Date.now(), why: h && h.r >= r ? h.why : why };
}
export const lowerAll = (keep = () => false) => { for (const n of NAMES) if (!keep(rt[n].hand)) rt[n].hand = null; };

// Reading pace: readUntil (the last message's reading time), typing and read-aloud in a browser hold the queue.
export const pace = { readUntil: 0, typingAt: 0, speakingAt: 0, ttsActiveAt: 0 };

// Finished replies waiting to be published: {chat, agent, text, basedOn, ms, hand, stance, notes, jobs, todo, dms, files, …}.
// held: a note about what comes next ("进入自由辩") waits until the replies already written are published, so it lands
// between the last reply of one phase and the first of the next even while replies wait for reading or read-aloud.
const saved = JSON.parse(getSetting('queue') || '{}');
export const ready = (saved.ready || []).filter(r => chatExists(r.chat));
const held = (saved.held || []).filter(h => chatExists(h.chat));
const save = () => setSetting('queue', JSON.stringify({ ready, held }));
export const addReady = r => { ready.push(r); save(); };
export const queued = (c = chatId) => ready.filter(r => r.chat === c);
export const inQueue = a => ready.some(r => r.chat === chatId && r.agent === a);
// Removes and returns the replies matching f.
export function dropReady(f) {
  const out = ready.filter(f);
  if (out.length) { ready.splice(0, ready.length, ...ready.filter(r => !f(r))); save(); }
  return out;
}
// In a discussion that isn't the current one (the user switched away mid-turn) there is nothing to wait for: posted at once.
export const noteNext = (text, c = chatId) => (c === chatId ? (held.push({ chat: c, text }), save()) : note(text, c));
export function releaseHeld() {
  if (!held.length || ready.some(r => r.chat === chatId)) return;
  const due = held.splice(0);
  save();
  for (const h of due) if (h.chat === chatId) note(h.text);
}
export const dropHeld = () => { held.length = 0; save(); };

export const thinking = a => rt[a].status === 'thinking';
export const busy = () => NAMES.some(thinking) || ready.some(r => r.chat === chatId);
export const present = a => S.enabled[a] && rt[a];
// Playing a game turn now. A member still in an ordinary turn (talk after the last game) gets its game turn after it.
export const inGame = a => rt[a]?.status === 'thinking' && rt[a].play;

// The round (= last user message id) the moderator already wrapped up: nothing raises hands until the user writes again.
export let wrapRound = 0;
export const setWrapRound = r => { wrapRound = r; };
export const wrapped = (c = chatId) => wrapRound === lastUserId(c);

// The scheduler (room.mjs) registers itself; anything that changes who may speak calls pump() to let it look again.
export let pump = () => {};
export const setPump = f => { pump = f; };
