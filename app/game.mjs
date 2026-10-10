// Game mode: the members play any game the user describes, run by a member the user names as host ("@claude 主持，
// 玩狼人杀"). The host announces the rules, sends private setups by DM, and drives the game with one phase marker per
// turn: the players talk in turn (public, or [DM @x] lines), or give secret orders ([ACT], sent only to the host) all at
// once. After every phase the host gets the turn back. It keeps the state in a private ledger the server stores and hands
// back every turn, so a lost CLI session doesn't lose the game. With code execution on it may write the rules as a
// program in its workspace and run it to resolve turns: its call, not ours. Everything here is pure; server.mjs runs it.
// (A built-in commons game was dropped: one member emptied the lake as soon as it paid, every game.)

// Who speaks when the host doesn't say: everyone, `laps` times, each lap in a fresh random order (a fixed rotation let
// the same members always answer last, having heard everyone). Turns still follow one another: the order is this
// queue, not who finishes thinking first.
export function talkOrder(players, laps, rand = Math.random) {
  return Array.from({ length: laps }, () => {
    const o = [...players];
    for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
    return o;
  }).flat();
}

export const HOST_TURNS = 60; // ponytail: a cap on host turns so a game can't run forever; raise it if real games need more

// The host's reply: [STATE] starts its ledger (the rest of the reply); [PHASE talk n @b @a] / [PHASE orders @a @b] / [PAUSE]
// / [END] on a line of its own is the next step (the last one counts; none: the game pauses).
// Returns {body, next: {kind, laps?, who?} | null, ledger | null}.
export function parseHost(raw) {
  const i = raw.search(/^[ \t>*_-]*\[STATE\]/im);
  const ledger = i < 0 ? null : raw.slice(i).replace(/^[ \t>*_-]*\[STATE\][*_]*[ \t:：]*/i, '').trim().slice(0, 30000);
  let next = null;
  const body = (i < 0 ? raw : raw.slice(0, i)).replace(/^[ \t>*_-]*\[(PHASE|END|PAUSE)\b([^\]]*)\][*_]*(.*)$/gim, (_, k, arg, rest) => {
    const [kind, ...more] = arg.trim().split(/\s+/);
    if (/^end$/i.test(k)) next = { kind: 'end' };
    else if (/^pause$/i.test(k)) next = { kind: 'pause' };
    else if (/^talk$/i.test(kind)) next = { kind: 'talk', laps: Math.min(3, Math.max(1, parseInt(more.find(x => /^\d+$/.test(x))) || 1)),
      who: `${more.filter(x => !/^\d+$/.test(x)).join(' ')} ${rest}` };
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
    + `Each of your turns: first write what the whole table hears (short). Then send private information: [DM @player] `
    + `at the start of a line, followed by the message, which may run over several lines (a table, a list): everything up to `
    + `the next [DM ...] or the marker below is private to that player. Then put exactly one of these on a line of its own:\n`
    + `[PHASE talk] (the players speak one after another, once each, in a random order; [PHASE talk 2]: twice; they may DM each other). To set who `
    + `speaks and in what order, list them: [PHASE talk @c @a] (only those, in that order; name someone twice to let them `
    + `speak twice)\n`
    + `[PHASE orders] (every player secretly sends you an order at the same time) or [PHASE orders @a @b] (only those `
    + `players, e.g. a night action). Their orders reach you as private messages marked "secret order".\n`
    + `[PAUSE] to stop the game until the user replies (a broken program, a rule question); say why in public.\n`
    + `[END] when the game is over: announce the result and the ranking first.\n`
    + `A reply without one of these pauses the game too.\n`
    + `After every phase you get the turn back. Finish within ${HOST_TURNS} turns of yours (this is turn ${g.round + 1}).\n`
    + `Keep the game state in your private ledger: end every reply with a line [STATE] followed by the full current state `
    + `(positions, resources, roles, who did what, rules details): it replaces the previous one, only you and the user see `
    + `it, and you get it back every turn. Rely on it rather than memory.\n`
    + (exec ? `If the game has rules that are easy to get wrong (scoring, combat, dice), you may write them as a program in `
      + `your workspace and run it to resolve each phase; that is your choice. Every member runs as the same OS user, so `
      + `players could read files in your workspace: keep secrets (hidden roles, private values, random seeds) in your `
      + `ledger, not in files; when your program needs them, write them to a temporary file and delete it in the same turn.\n` : '')
    + `Your ledger now:\n${g.ledger || '(empty)'}`;
}

export function playerBrief(g, a, phase, handle, exec) {
  const head = `You are a player in a game hosted by ${handle(g.host)} (a member who runs it and doesn't play), as the user `
    + `asked. The rules are what the host announced, and what it told you privately. Players: ${g.players.map(handle).join(', ')}; `
    + `you are ${handle(a)}. The user sees everything, private messages included. `
    + (exec ? 'You may run code in your own workspace to work out a strategy (simulations, estimates). ' : '')
    + `Don't read the files of other members or of the host.\n\n`;
  if (phase === 'orders') return head + 'Now: the host asks for your order. Reply with your order in one line [ACT] <order>, '
    + 'plus anything the host needs to resolve it. This reply goes only to the host; nobody else reads it.';
  if (phase === 'talk') return head + 'Now: the table talks, in turn. Write a short public message. To talk to one player '
    + 'privately (or to ask the host), put [DM @handle] at the start of a line after your public message: everything up to '
    + 'the next [DM ...] line or the end of your reply is private (at most 3 per turn). Play to win: '
    + 'propose, promise, bluff or lie as the game allows. Answer PASS to say nothing in public (your DM lines still go out).';
  return head + 'The game is over. Talk about it in public: what you did and why, what you would do differently.';
}
