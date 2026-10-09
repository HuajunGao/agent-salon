// Game mode: the members play a resource game. A program is the host: it keeps the state, checks orders and resolves
// rounds, so nothing depends on a model remembering the numbers. Each round: negotiation (every player speaks `laps`
// times in turn, in public or by [DM @x] lines), then simultaneous secret orders ([ACT] lines, read only by the host),
// then the host resolves. Everything here is pure; server.mjs runs the turns.
//
// The one game so far is the commons (after GovSim, "Cooperate or Collapse", 2024): a shared lake of fish that doubles
// back up to its capacity after each catch, and collapses when fished out. Each player's score is its own catch, so
// everyone gains by taking a little more than the others, and the lake dies if everyone does. Individual catches are
// secret until the end: claims about one's own catch can't be checked, so promises and trust carry the game.
// ponytail: one engine object; a second game (e.g. Diplomacy through the `diplomacy` Python package) gets the same
// shape (setup / rules / view / act / resolve / final / idle / show) and a picker.

const COLLAPSE = 5; // fewer tonnes than this left after a catch and the lake is dead
// Hard mode: the regrowth is random and only the lake's new size is public, so a smaller lake can be bad luck or a cheat;
// and nobody knows the last round (after round END_FROM on, each round ends the game with chance END_P; `rounds` is a
// cap the players aren't told), so there is no last round to plan a grab for.
const GROW = [1.6, 2.4], END_FROM = 3, END_P = 0.25;

export const commons = {
  label: '公地捕鱼',
  idle: { take: 0 },
  show: o => `${o.take} 吨`,

  setup(players, { rounds = 6, cap = 100, hard = false } = {}) {
    return { players, rounds, cap, hard, pool: cap, round: 1, caught: Object.fromEntries(players.map(a => [a, 0])), history: [] };
  },

  rules: g => `Game: THE COMMONS. ${g.players.length} fishers share one lake. It holds at most ${g.cap} tonnes of fish. Each `
    + `round, after the talk, every fisher secretly orders how many tonnes to catch. If the orders add up to more than the `
    + `lake holds, each gets a share of what is there in proportion to its order. Whatever is left then `
    + (g.hard ? `regrows by a random factor between ${GROW[0]} and ${GROW[1]} (weather, spawning), up to ${g.cap}. ` : `doubles, up to ${g.cap}. `)
    + `If fewer than ${COLLAPSE} tonnes are left after a catch, the lake collapses and the game ends at once. `
    + (g.hard ? `Nobody knows when the game ends: from round ${END_FROM} on, each round has a 1 in ${1 / END_P} chance of being `
      + `the last, announced only after it is played. ` : `The game lasts ${g.rounds} rounds. `)
    + `Your score is your own total catch; at the end the fishers are ranked by it. Catches are secret: each round everyone `
    + (g.hard ? `learns only the lake's new size, not even the total caught, so a smaller lake may be bad luck or someone's `
      + `cheating, and nobody can check what anyone says about their own catch. ` : `learns only the total caught and the `
      + `lake's new size, so nobody can check what anyone says about their own catch. `)
    + `The full record is revealed when the game ends.`,

  // What player a knows: the lake now, its own catches, the public totals. After the game: everything.
  view(g, a, handle = p => p) {
    const total = h => (!g.hard || g.over ? `${h.total} caught in total (you: ${h.got[a]}` : `you caught ${h.got[a]} (the total is secret`);
    const lines = g.history.map(h => `Round ${h.round}: the lake had ${h.before}, ${total(h)}`
      + `${h.bad[a] ? `; your order was invalid: ${h.bad[a]}, counted as 0` : ''}), ${h.after} after regrowth`
      + (g.hard && g.over ? ` (×${h.grow})` : '') + '.'
      + (g.over ? ` Everyone: ${g.players.map(p => `${handle(p)} ${h.got[p]}`).join(', ')}.` : ''));
    const why = { collapse: 'the lake collapsed', done: `all ${g.rounds} rounds played`, ended: `it ended at random after round ${g.history.at(-1)?.round}` };
    return (g.over ? `The game is over (${why[g.over]}). Final catches: ${rank(g).map(([p, n]) => `${handle(p)} ${n}`).join(', ')}.`
      : `Round ${g.round}${g.hard ? '' : ` of ${g.rounds}`}. The lake holds ${g.pool} tonnes now. Your catch so far: ${g.caught[a]} tonnes.`)
      + (lines.length ? `\n${lines.join('\n')}` : '');
  },

  // An order is the first whole number in the [ACT] line: the tonnes to catch.
  act(g, a, text) {
    const n = Number(String(text).match(/-?\d+(\.\d+)?/)?.[0]);
    if (!Number.isInteger(n) || n < 0) return { error: `要一个不小于 0 的整数吨数，收到「${String(text).slice(0, 40)}」` };
    return { order: { take: n } };
  },

  // Resolves the round in place (g.over: 'collapse' | 'done' | 'ended' (hard: at random), else the next round) and returns
  // the host's note.
  resolve(g, orders, who, rand = Math.random) {
    const before = g.pool, want = g.players.reduce((s, a) => s + orders[a].take, 0);
    const got = Object.fromEntries(g.players.map(a => [a, want <= before ? orders[a].take : Math.floor(orders[a].take * before / want)]));
    const total = g.players.reduce((s, a) => s + got[a], 0), left = before - total;
    const grow = g.hard ? +(GROW[0] + (GROW[1] - GROW[0]) * rand()).toFixed(2) : 2;
    g.pool = left < COLLAPSE ? left : Math.min(g.cap, Math.round(left * grow));
    for (const a of g.players) g.caught[a] += got[a];
    const bad = Object.fromEntries(g.players.filter(a => orders[a].error).map(a => [a, orders[a].error]));
    g.history.push({ round: g.round, before, want, got, total, after: g.pool, grow, bad });
    if (left < COLLAPSE) g.over = 'collapse'; else if (g.round >= g.rounds) g.over = 'done';
    else if (g.hard && g.round >= END_FROM && rand() < END_P) g.over = 'ended'; else g.round++;
    return `🎣 第 ${g.history.at(-1).round} 轮结算：湖里原有 ${before} 吨，${want > before ? `大家要 ${want} 吨超过了存量，按比例分，` : ''}`
      + `共捕 ${total} 吨（${g.players.map(a => `${who(a)} ${got[a]}`).join('、')}），剩 ${left} 吨，`
      + (left < COLLAPSE ? '**湖崩溃了**。' : `${g.hard ? `按 ×${grow} ` : ''}恢复到 ${g.pool} 吨。`)
      + (g.over === 'ended' ? '**抽中了结束**。' : '') + (g.hard ? '成员们只知道湖的新大小。' : '成员们只知道总数。');
  },

  // The end: standings, and how the group did against the most a sustainable lake gives
  // (half the lake each round keeps it full, and the last round can take everything).
  final(g, who) {
    const all = g.players.reduce((s, a) => s + g.caught[a], 0), best = (g.rounds - 1) * g.cap / 2 + g.cap;
    const last = g.history.at(-1).round, why = { collapse: `第 ${last} 轮湖崩溃了`, done: `打满 ${g.rounds} 轮`, ended: `第 ${last} 轮后随机结束` };
    return `🏁 游戏结束（${why[g.over]}）。排名：` + rank(g).map(([a, n], i) => `${i + 1}. ${who(a)} ${n} 吨`).join('；')
      + `。全体合计 ${all} 吨${g.hard ? '' : `，可持续捕捞最多能有 ${best} 吨`}。完整记录已经告诉大家。`;
  },
};
const rank = g => g.players.map(a => [a, g.caught[a]]).sort((x, y) => y[1] - x[1]);

// Who speaks in round r's negotiation: everyone, `laps` times, starting one seat later each round.
export function talkOrder(players, round, laps) {
  const i = (round - 1) % players.length, o = [...players.slice(i), ...players.slice(0, i)];
  return Array.from({ length: laps }, () => o).flat();
}

// What a player is told for its turn: phase 'talk' | 'orders' | 'over'. handle(a) gives the @handle.
export function gameBrief(engine, g, a, phase, handle) {
  const head = `${engine.rules(g)}\nPlayers: ${g.players.map(handle).join(', ')}; you are ${handle(a)}. The user hosts the game `
    + `and sees everything, private messages and orders included; the other players see only what is addressed to them.\n\n${engine.view(g, a, handle)}\n\n`;
  if (phase === 'orders') return head + `Now: the orders for round ${g.round}. Decide how many tonnes you catch this round and `
    + 'reply with one line: [ACT] <tonnes>, e.g. [ACT] 12. Orders are simultaneous and secret. This reply goes only to the '
    + 'host: nobody else reads it, so you may add one short sentence of your private reasoning for the host.';
  if (phase === 'talk') return head + `Now: the negotiation before round ${g.round}'s orders. Players speak in turn, ${g.laps} `
    + 'times each. Write a short public message to the table. To talk to one player privately, add a line of its own: '
    + '[DM @handle] message (only that player reads it; at most 3 per turn). You may propose deals, promise, warn, bluff '
    + 'or lie, as you judge best for your score. Don\'t give your order now: the orders come after the talk. Answer PASS '
    + 'to say nothing in public (your DM lines still go out).';
  return head + 'Talk about the game in public: what you did and why, who kept their word, what you would do differently.';
}

// ---------- a free game: a member hosts, the others play ----------
// The user names the host ("@claude 主持，玩狼人杀") and the game; the host announces the rules, sends private setups by
// DM, and drives the game with one phase marker per turn. After every phase the host gets the turn back, with the
// players' secret orders as private messages. It keeps the state in a private ledger the server stores and hands back
// every turn, so a lost CLI session doesn't lose the game. With code execution on it may write the rules as a program
// in its workspace and run it to resolve turns: its call, not ours.
export const HOST_TURNS = 60; // ponytail: a cap on host turns so a game can't run forever; raise it if real games need more

// The host's reply: [STATE] starts its ledger (the rest of the reply); [PHASE talk n] / [PHASE orders @a @b] / [END] on a
// line of its own is the next step (the last one counts). Returns {body, next: {kind, laps?, who?} | null, ledger | null}.
export function parseHost(raw) {
  const i = raw.search(/^[ \t>*_-]*\[STATE\]/im);
  const ledger = i < 0 ? null : raw.slice(i).replace(/^[ \t>*_-]*\[STATE\][*_]*[ \t:：]*/i, '').trim().slice(0, 8000);
  let next = null;
  const body = (i < 0 ? raw : raw.slice(0, i)).replace(/^[ \t>*_-]*\[(PHASE|END)\b([^\]]*)\][*_]*(.*)$/gim, (_, k, arg, rest) => {
    const [kind, ...more] = arg.trim().split(/\s+/);
    if (/^end$/i.test(k)) next = { kind: 'end' };
    else if (/^talk$/i.test(kind)) next = { kind: 'talk', laps: Math.min(3, Math.max(1, parseInt(more[0]) || 1)) };
    else if (/^orders?$/i.test(kind)) next = { kind: 'orders', who: `${more.join(' ')} ${rest}` };
    return '';
  });
  return { body, next, ledger };
}

export function hostBrief(g, handle, exec, first) {
  return `You are the HOST (主持人) of a game the user asked for in this chat; you don't play. Players: `
    + `${g.players.map(handle).join(', ')}. Run the game fairly, keep to the rules you announce, and keep it moving.\n`
    + (first ? 'This is your first turn: announce the rules briefly in public, send each player its private setup (role, '
      + 'cards, resources, goal) by DM, and start the first phase.\n' : '')
    + `Each of your turns: write what the whole table hears (short). Send private information with lines of their own: `
    + `[DM @player] text (only that player reads it). Then put exactly one of these on a line of its own:\n`
    + `[PHASE talk] (the players speak in turn, once each; [PHASE talk 2]: twice; they may DM each other)\n`
    + `[PHASE orders] (every player secretly sends you an order at the same time) or [PHASE orders @a @b] (only those `
    + `players, e.g. a night action). Their orders reach you as private messages marked "secret order".\n`
    + `[END] when the game is over: announce the result and the ranking first.\n`
    + `After every phase you get the turn back. Finish within ${HOST_TURNS} turns of yours (this is turn ${g.round + 1}).\n`
    + `Keep the game state in your private ledger: end every reply with a line [STATE] followed by the full current state `
    + `(positions, resources, roles, who did what, rules details): it replaces the previous one, only you and the user see `
    + `it, and you get it back every turn. Rely on it rather than memory.\n`
    + (exec ? `If the game has rules that are easy to get wrong (scoring, combat, dice), you may write them as a program in `
      + `your workspace and run it to resolve each phase; that is your choice. Players can't run code during the game.\n` : '')
    + `Your ledger now:\n${g.ledger || '(empty)'}`;
}

export function playerBrief(g, a, phase, handle) {
  const head = `You are a player in a game hosted by ${handle(g.host)} (a member who runs it and doesn't play), as the user `
    + `asked. The rules are what the host announced, and what it told you privately. Players: ${g.players.map(handle).join(', ')}; `
    + `you are ${handle(a)}. The user sees everything, private messages included. During the game don't run code or read `
    + `files of other members or of the host.\n\n`;
  if (phase === 'orders') return head + 'Now: the host asks for your order. Reply with your order in one line [ACT] <order>, '
    + 'plus anything the host needs to resolve it. This reply goes only to the host; nobody else reads it.';
  if (phase === 'talk') return head + 'Now: the table talks, in turn. Write a short public message. To talk to one player '
    + 'privately (or to ask the host), add a line of its own: [DM @handle] message (at most 3 per turn). Play to win: '
    + 'propose, promise, bluff or lie as the game allows. Answer PASS to say nothing in public (your DM lines still go out).';
  return head + 'The game is over. Talk about it in public: what you did and why, what you would do differently.';
}
