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

export const commons = {
  label: '公地捕鱼',
  idle: { take: 0 },
  show: o => `${o.take} 吨`,

  setup(players, { rounds = 6, cap = 100 } = {}) {
    return { players, rounds, cap, pool: cap, round: 1, caught: Object.fromEntries(players.map(a => [a, 0])), history: [] };
  },

  rules: g => `Game: THE COMMONS. ${g.players.length} fishers share one lake. It holds at most ${g.cap} tonnes of fish. Each `
    + `round, after the talk, every fisher secretly orders how many tonnes to catch. If the orders add up to more than the `
    + `lake holds, each gets a share of what is there in proportion to its order. Whatever is left then doubles, up to `
    + `${g.cap}. If fewer than ${COLLAPSE} tonnes are left after a catch, the lake collapses and the game ends at once. `
    + `The game lasts ${g.rounds} rounds. Your score is your own total catch; at the end the fishers are ranked by it. `
    + `Catches are secret: each round everyone learns only the total caught and the lake's new size, so nobody can check `
    + `what anyone says about their own catch. The full record is revealed when the game ends.`,

  // What player a knows: the lake now, its own catches, the public totals. After the game: everything.
  view(g, a, handle = p => p) {
    const lines = g.history.map(h => `Round ${h.round}: the lake had ${h.before}, ${h.total} caught in total (you: ${h.got[a]}`
      + `${h.bad[a] ? `; your order was invalid: ${h.bad[a]}, counted as 0` : ''}), ${h.after} after regrowth.`
      + (g.over ? ` Everyone: ${g.players.map(p => `${handle(p)} ${h.got[p]}`).join(', ')}.` : ''));
    return (g.over ? `The game is over (${g.over === 'collapse' ? 'the lake collapsed' : `all ${g.rounds} rounds played`}). `
      + `Final catches: ${rank(g).map(([p, n]) => `${handle(p)} ${n}`).join(', ')}.`
      : `Round ${g.round} of ${g.rounds}. The lake holds ${g.pool} tonnes now. Your catch so far: ${g.caught[a]} tonnes.`)
      + (lines.length ? `\n${lines.join('\n')}` : '');
  },

  // An order is the first whole number in the [ACT] line: the tonnes to catch.
  act(g, a, text) {
    const n = Number(String(text).match(/-?\d+(\.\d+)?/)?.[0]);
    if (!Number.isInteger(n) || n < 0) return { error: `要一个不小于 0 的整数吨数，收到「${String(text).slice(0, 40)}」` };
    return { order: { take: n } };
  },

  // Resolves the round in place (g.over: 'collapse' | 'done', else the next round) and returns the host's note.
  resolve(g, orders, who) {
    const before = g.pool, want = g.players.reduce((s, a) => s + orders[a].take, 0);
    const got = Object.fromEntries(g.players.map(a => [a, want <= before ? orders[a].take : Math.floor(orders[a].take * before / want)]));
    const total = g.players.reduce((s, a) => s + got[a], 0), left = before - total;
    g.pool = left < COLLAPSE ? left : Math.min(g.cap, left * 2);
    for (const a of g.players) g.caught[a] += got[a];
    const bad = Object.fromEntries(g.players.filter(a => orders[a].error).map(a => [a, orders[a].error]));
    g.history.push({ round: g.round, before, want, got, total, after: g.pool, bad });
    if (left < COLLAPSE) g.over = 'collapse'; else if (g.round >= g.rounds) g.over = 'done'; else g.round++;
    return `🎣 第 ${g.history.at(-1).round} 轮结算：湖里原有 ${before} 吨，${want > before ? `大家要 ${want} 吨超过了存量，按比例分，` : ''}`
      + `共捕 ${total} 吨（${g.players.map(a => `${who(a)} ${got[a]}`).join('、')}），剩 ${left} 吨，`
      + (left < COLLAPSE ? '**湖崩溃了**。' : `恢复到 ${g.pool} 吨。`) + '成员们只知道总数。';
  },

  // The end: standings, and how the group did against the most a sustainable lake gives
  // (half the lake each round keeps it full, and the last round can take everything).
  final(g, who) {
    const all = g.players.reduce((s, a) => s + g.caught[a], 0), best = (g.rounds - 1) * g.cap / 2 + g.cap;
    return `🏁 游戏结束（${g.over === 'collapse' ? `第 ${g.history.at(-1).round} 轮湖崩溃了` : `打满 ${g.rounds} 轮`}）。排名：`
      + rank(g).map(([a, n], i) => `${i + 1}. ${who(a)} ${n} 吨`).join('；')
      + `。全体合计 ${all} 吨，可持续捕捞最多能有 ${best} 吨。完整记录已经告诉大家。`;
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
