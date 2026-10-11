// Who speaks next, by the discussion's flow (rules in modes.mjs / game.mjs): a user message wakes the room; the
// relay passes the baton; a debate plays its script slot by slot; a game follows its host's phases. These functions
// only raise hands and move the flow's state (chats.state) on; the scheduler (room.mjs) starts the turns.
import { relayNext, debateSetup, debateScript, seatOf, PHASES, parseReply } from './modes.mjs';
import { talkOrder, HOST_TURNS } from './game.mjs';
import { q1 } from './db.mjs';
import { wsOf } from './workspace.mjs';
import { S, NAMES, enabledOrder, atOf, handle, tx } from './config.mjs';
import { chatId, chatState, saveState, rules, mentions, dmTo, note, insertMsg, logDecision, lastTalkId, turnsSinceUser } from './chats.mjs';
import { rt, raise, busy, noteNext, present, inGame } from './runtime.mjs';
import { resync } from './sse.mjs';

const lastAgent = () => q1(`SELECT sender FROM messages WHERE chat_id=? AND kind='agent' ORDER BY id DESC LIMIT 1`, chatId)?.sender;
const idle = () => !busy() && !NAMES.some(n => rt[n].hand); // nothing scheduled (e.g. after a stop)

// A user message wakes the room according to the flow.
export function wake(m) {
  const flow = rules(chatId).flow;
  if (flow === 'relay') return void (busy() || relay(lastAgent(), m.text)); // a busy relay hands on after its turn
  if (flow === 'debate') return debateOnUser(m);
  if (flow === 'game') return gameOnUser(m);
  const at = mentions(m.text);
  const target = m.reply_to && q1('SELECT sender FROM messages WHERE id=?', m.reply_to)?.sender;
  // Hands left from the previous round (an @ by a member) would keep their old reason and count as follow-ups that
  // Jev may filter out, not as answers to the user. The user's floor stays.
  for (const n of NAMES) if (rt[n].hand?.r < 100) rt[n].hand = null;
  if (at.length) for (const n of at) raise(n, 10, '@ by user');
  else for (const n of NAMES) raise(n, n === target ? 3 : 1, n === target ? `reply to #${m.reply_to}` : 'user message');
}

// Story relay: the baton goes to the member the text @mentions, else to the next one after `after`, skipping members
// that have had their turns since the user last spoke. When everyone has, the room goes quiet and hands the floor back.
export function relay(after, text) {
  const order = enabledOrder(), open = n => turnsSinceUser(n) < S.turnCap;
  let next = order.length && relayNext(order, after, mentions(text || '')[0]);
  for (let i = 0; next && !open(next) && i < order.length; i++) next = relayNext(order, next, null);
  if (next && open(next)) raise(next, 5, 'relay');
}

// ---------- debate ----------
// The first message in a debate is the motion: sides are drawn, then the script's slots are played in order.
function debateOnUser(m) {
  const st = chatState(chatId), d = st.debate;
  if (!d) {
    const names = enabledOrder();
    if (names.length < 2) {
      st.debate = { done: true, skipped: true }; saveState(chatId, st);
      note(tx('🧭 辩论至少需要 2 位参与成员，先按自由讨论进行。'));
      return wake(m);
    }
    const nd = { ...debateSetup(names), motion: m.id };
    st.debate = { ...nd, script: debateScript(nd) }; saveState(chatId, st);
    const who = n => (n === 'user' ? tx('你') : `@${atOf(n)}`);
    logDecision('debate', null, { message_id: m.id, detail: { pro: nd.pro, con: nd.con, judge: nd.judge } });
    note(tx('🧭 辩论开始，辩题是 #{id}。抽签结果：正方 {pro}；反方 {con}；评委 {judge}。顺序：开篇立论、驳论、自由辩、结辩，最后由评委评判，之后自由讨论。你随时可以插话。',
      { id: m.id, pro: nd.pro.map(who).join(tx('、')), con: nd.con.map(who).join(tx('、')), judge: who(nd.judge) }));
    return nextSlot(chatId);
  }
  if (d.script[d.at]?.phase === 'verdict' && d.judge === 'user') return finishDebate(chatId); // the user's verdict
  if (idle()) nextSlot(chatId);
}
// Raise the hand for the current slot (skipping members no longer taking part); free-debate slots go to whoever of
// that side has spoken least. When the user judges, the debate waits for their verdict.
function nextSlot(c) {
  if (c !== chatId) return;
  const st = chatState(c), d = st.debate;
  for (; d.at < d.script.length; d.at++) {
    const s = d.script[d.at], prev = d.script[d.at - 1];
    if (s.phase === 'verdict' && d.judge === 'user') { noteNext(tx('🧭 结辩结束。请你作为评委判胜负、说说理由；你发言后进入自由讨论。')); break; }
    const spoke = n => q1('SELECT count(*) n FROM messages WHERE chat_id=? AND sender=? AND id>?', c, n, d.motion).n;
    const who = s.phase === 'free' ? d[s.side].filter(n => S.enabled[n]).sort((x, y) => spoke(x) - spoke(y))[0] : s.who;
    if (!who || !S.enabled[who]) continue;
    if (prev && prev.phase !== s.phase) noteNext(tx('🧭 进入{phase}。', { phase: tx(PHASES[s.phase]) }));
    rt[who].hand = { r: 50, since: Date.now(), why: 'debate', slot: d.at, seat: seatOf(d, who) };
    break;
  }
  saveState(c, st);
}
// A slot's turn is over (published, passed or failed): on to the next one. The judge's verdict ends the debate when
// it is published (see publishOne), so the free discussion starts from it.
export function advanceDebate(c, slot, published) {
  const st = chatState(c), d = st.debate;
  if (!d || d.done || d.at !== slot) return;
  if (d.script[slot].phase === 'verdict') return void (published || finishDebate(c));
  d.at++; saveState(c, st);
  nextSlot(c);
}
export function finishDebate(c) {
  const st = chatState(c);
  st.debate.done = true; saveState(c, st);
  logDecision('debate-over', null, { message_id: lastTalkId(c) });
  if (c !== chatId) return;
  note(tx('🧭 辩论结束，进入自由讨论：大家不必再守持方，说说自己真实的想法。'));
  for (const n of NAMES) raise(n, 1, 'after the debate');
}
// A stop dropped replies a debate had already moved past: their slots are played again.
export function rewindDebate(c, slots) {
  const st = chatState(c);
  if (st.debate && !st.debate.done && slots.length) { st.debate.at = Math.min(st.debate.at, ...slots); saveState(c, st); }
}

// ---------- game ----------
// The first message names the host (the first enabled member it @mentions; none: the server asks for one) and
// what to play; the other enabled members play (game.mjs). State in chats.state.game: host, players, phase ('host' |
// 'talk' | 'orders' | 'over'), round (host turns played), the talk queue, step (talk turns played, so a turn is counted
// once), waiting (who owes an order), the orders in, and the host's ledger. Hands carry game: {round, phase, step}.
// Talk turns follow one another; orders all start at once and go to the host as private messages (role 'order').
// Players may run code like in any turn (simulations, strategy); their tool calls are checked for peeking (audit).
function gameOnUser(m) {
  const st = chatState(chatId);
  if (st.game?.over) { for (const n of NAMES) raise(n, 1, 'user message'); return; }
  if (!st.game) {
    const host = mentions(m.text).find(n => S.enabled[n]);
    if (!host) return note(tx('🎲 博弈要有人主持：@ 一位成员当主持人，再说说玩什么、规则是什么，比如“@claude 主持，我们玩狼人杀”。'));
    const players = [...enabledOrder().filter(n => n !== host), ...S.userPlays ? ['user'] : []];
    if (players.length < 2) return note(tx('🎲 博弈除了主持人至少还要 2 位玩家。'));
    st.game = { host, players, phase: 'host', round: 0, step: 0, orders: {}, waiting: [], queue: [], ledger: '', ...S.userPlays && { user: true } };
    saveState(chatId, st);
    logDecision('game-start', null, { message_id: m.id, detail: { host, players } });
    note(tx(S.userPlays ? '🎲 博弈开始：{host} 主持，玩家 {players}。主持人先公布规则、私信发身份或资源，再一个阶段一个阶段推进（轮流发言 / 秘密行动），每个阶段后由它结算。你也是玩家：只看得到公开发言和发给你的私信，游戏结束后再全部公开。私信某人：单独一行 [DM @某人]，后面写内容。'
      : '🎲 博弈开始：{host} 主持，玩家 {players}。主持人先公布规则、私信发身份或资源，再一个阶段一个阶段推进（轮流发言 / 秘密行动），每个阶段后由它结算。私信、秘密指令和它的私密账本你都看得到。',
      { host: handle(host), players: players.map(handle).join(tx('、')) }));
    return gameNext(chatId);
  }
  if (idle()) gameNext(chatId);
}
export function gameNext(c) {
  if (c !== chatId) return;
  const st = chatState(c), g = st.game;
  if (!g?.host || g.over) return;
  const hand = phase => ({ r: 50, since: Date.now(), why: 'game', game: { round: g.round, phase, step: g.step } });
  if (g.phase === 'talk') {
    while (g.queue.length && g.queue[0] !== 'user' && !present(g.queue[0])) { g.queue.shift(); g.step++; }
    if (g.queue[0] === 'user') return askUser(c, st, 'talk');
    if (g.queue.length) { rt[g.queue[0]].hand = hand('talk'); return saveState(c, st); }
    g.phase = 'host';
  }
  if (g.phase === 'orders') {
    for (const a of g.waiting) {
      if (a === 'user' || a in g.orders || rt[a]?.hand?.game || inGame(a)) continue;
      if (present(a)) rt[a].hand = hand('orders'); else g.orders[a] = true; // not taking part: nothing to wait for
    }
    if (g.waiting.some(a => !(a in g.orders))) return g.waiting.includes('user') && !('user' in g.orders) ? askUser(c, st, 'orders') : saveState(c, st);
    g.phase = 'host';
  }
  if (present(g.host) && !rt[g.host].hand?.game && !inGame(g.host)) rt[g.host].hand = hand('host');
  saveState(c, st);
}
// A game whose turns were due while the user was elsewhere (gameNext only schedules the current discussion) or the server
// was down carries on. Not in the host phase: that is also how a paused game waits for the user's message.
export function resumeGame(id) {
  const g = chatState(id).game;
  if (g && !g.over && (g.phase === 'talk' || g.phase === 'orders')) gameNext(id);
}
// The user's turn in a game the user plays: told once per turn; the user's next message plays it (userPlay).
function askUser(c, st, phase) {
  const g = st.game, at = `${g.round}.${phase === 'talk' ? g.step : 'o'}`;
  if (g.asked !== at) { g.asked = at; noteNext(tx(phase === 'talk' ? '🎲 轮到你发言了。' : '🎲 轮到你交秘密指令：你的下一条消息只发给主持人。'), c); }
  saveState(c, st);
}
export function userPlay(text, files, reply_to) {
  const st = chatState(chatId), g = st.game;
  if (g.phase === 'orders' && g.waiting.includes('user') && !('user' in g.orders)) {
    g.orders.user = true; saveState(chatId, st);
    insertMsg({ chat_id: chatId, sender: 'user', kind: 'user', dm: g.host, role: 'order', mode: 'game', text, files });
    logDecision('game-order', null, { detail: { round: g.round, user: true } });
    return gameNext(chatId);
  }
  // [DM @x] lines go to x only (players and the host), as in the members' replies; the rest is public
  const p = /\[DM\b/i.test(text) ? parseReply(text) : { text, dms: [] };
  for (const d of p.dms) { const to = dmTo(d.to);
    if (to !== 'user' && [...g.players, g.host].includes(to)) insertMsg({ chat_id: chatId, sender: 'user', kind: 'user', dm: to, mode: 'game', text: d.text }); }
  if (!p.text && !files.length) return;
  const m = insertMsg({ chat_id: chatId, sender: 'user', kind: 'user', text: p.text, reply_to: reply_to || null, files });
  logDecision('user', null, { message_id: m.id, detail: { mentions: mentions(p.text), game: true } });
  if (g.phase === 'talk' && g.queue[0] === 'user') return gameTalkDone(chatId, { round: g.round, step: g.step });
  wake(m);
}
export function gameTalkDone(c, h) {
  const st = chatState(c), g = st.game;
  if (!g || g.over || g.phase !== 'talk' || g.round !== h.round || g.step !== h.step) return;
  g.queue.shift(); g.step++;
  saveState(c, st);
  gameNext(c);
}
// An order turn's reply goes to the host as a private message.
export function gameOrder(c, a, h, res) {
  const st = chatState(c), g = st.game;
  if (!g?.host || g.over || g.phase !== 'orders' || g.round !== h.round || a in g.orders) return;
  const p = res.error ? null : parseReply(res.text);
  g.orders[a] = true; saveState(c, st);
  insertMsg({ chat_id: c, sender: a, kind: 'agent', dm: g.host, role: 'order', mode: 'game', latency_ms: res.ms, model: S.models[a] || 'default',
    text: p ? [...p.acts.map(x => `[ACT] ${x}`), p.text].filter(Boolean).join('\n') || '（空）' : `（这一回合出错了，没有指令：${res.error.slice(0, 80)}）` });
  logDecision('game-order', a, { latency_ms: res.ms, detail: { round: g.round, acts: p?.acts || [], error: res.error || null } });
  gameNext(c);
}
// The host's turn is over (its public text and DMs are on their way): keep its ledger and start the phase it asked for.
// h: null when the turn failed (it plays again after the user's next message).
export function hostDone(c, play, h) {
  const st = chatState(c), g = st.game;
  if (!g?.host || g.over || g.phase !== 'host' || g.round !== play.round) return;
  if (!h) return void note(tx('⚠ 主持人这一回合没成功，发一条消息让它再来一次。'), c);
  if (h.ledger != null) g.ledger = h.ledger;
  g.round++;
  // [PAUSE], or no next step at all (a guess could run the wrong phase): wait for the user, whose message wakes the host
  if (!h.next || h.next.kind === 'pause') {
    saveState(c, st);
    logDecision('game-pause', g.host, { chat: c, detail: { round: g.round, asked: !!h.next } });
    return noteNext(tx(h.next ? '⏸ 主持人暂停了比赛（原因见它的发言）。发一条消息让它继续。'
      : '⏸ 主持人这一回合没写下一步（[PHASE …] / [PAUSE] / [END]），比赛先暂停。发一条消息让它继续。'), c);
  }
  const next = h.next;
  if (next.kind === 'end' || g.round >= HOST_TURNS) {
    Object.assign(g, { over: next.kind === 'end' ? 'end' : 'cap', phase: 'over' }); saveState(c, st);
    logDecision('game-over', g.host, { chat: c, detail: { over: g.over, turns: g.round } });
    noteNext(g.over === 'end' ? tx('🏁 主持人宣布游戏结束。') : tx('🏁 主持人已经主持了 {n} 回合，游戏到此结束。', { n: HOST_TURNS }), c);
    if (c === chatId) { for (const a of [...g.players, g.host]) if (a !== 'user') raise(a, 1, 'after the game'); if (g.user) resync(); }
    return;
  }
  // the host's order (handles as listed, repeats allowed), else everyone in a random order
  const order = (next.who || '').split(/\s+/).filter(t => t.startsWith('@')).map(t => dmTo(t.slice(1).replace(/[,，、。]+$/, ''))).filter(x => g.players.includes(x));
  if (next.kind === 'talk') Object.assign(g, { phase: 'talk',
    queue: order.length ? Array.from({ length: next.laps }, () => order).flat() : talkOrder(g.players, next.laps) });
  else {
    const who = [...new Set(order)];
    Object.assign(g, { phase: 'orders', waiting: who.length ? who : g.players, orders: {} });
  }
  saveState(c, st);
  logDecision('game-phase', g.host, { chat: c, detail: { round: g.round, ...next, waiting: g.waiting } });
  noteNext(next.kind === 'talk' ? tx('🎲 轮流发言') + (order.length ? tx('：{order}', { order: g.queue.map(handle).join(' → ') })
    : next.laps > 1 ? tx('（每人 {n} 次）', { n: next.laps }) : '') + tx('。')
    : tx('🎲 秘密行动：{who}，指令只交给主持人。', { who: g.waiting.map(handle).join(tx('、')) }), c);
  gameNext(c);
}
// The user ends the game (e.g. its host never wrote [END] and kept the talk going): turns still running finish
// without moving it on, and the next message is free talk.
export function endGame() {
  const st = chatState(chatId), g = st.game;
  if (!g?.host || g.over) return;
  for (const n of NAMES) if (rt[n].hand?.game) rt[n].hand = null;
  Object.assign(g, { over: 'user', phase: 'over' }); saveState(chatId, st);
  logDecision('game-over', null, { detail: { over: 'user', turns: g.round } });
  note(tx('🏁 你结束了这局游戏。之后的消息就是普通聊天。'));
  if (g.user) resync();
}
// Another game in the same discussion: everyone keeps what happened (it's all in their sessions). The finished game is
// kept in st.games; the user's next message starts the new one (@ a host) as in a new discussion.
export function newGame() {
  const st = chatState(chatId);
  if (!st.game?.over) return;
  (st.games ??= []).push(st.game); delete st.game; saveState(chatId, st);
  for (const n of NAMES) rt[n].hand = null;
  logDecision('game-new', null, { detail: { games: st.games.length } });
  note(tx('🎲 再开一局（这个讨论的第 {n} 局，大家都记得前面的）：@ 一位成员当主持人，说说玩什么。', { n: st.games.length + 1 }));
}
// Every CLI runs as the same OS user, so a player could read other members'
// workspaces (the host's program and files) or CLI session files (which hold their private messages). The turn's tool log
// is checked for such paths; agy logs only tool names, so its reads can't be checked.
const PEEK = /\.claude\/projects|\.codex\/sessions|\.gemini\/|opencode\/(storage|project)|chat\.db/;
export function audit(c, a, log) {
  const hits = (log || '').split('\n').filter(l => l.startsWith('🔧')
    && (PEEK.test(l) || NAMES.some(n => n !== a && (l.includes(wsOf(n)) || l.includes(`../${n}`)))));
  if (!hits.length) return;
  logDecision('game-audit', a, { detail: { hits } });
  note(`${tx('🚨 {who} 这一回合碰了不该看的地方：', { who: handle(a) })}\n${hits.slice(0, 3).map(l => `\`${l.slice(0, 160)}\``).join('\n')}`, c);
}
