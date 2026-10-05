// Discussion modes. Each mode is a small set of rules that server.mjs runs:
//   flow       who speaks next: 'free' (raised hands, scored), 'relay' (one member after another) or 'debate'
//              (sides and a fixed order of play)
//   stance     replies end with a [STANCE] line (the stance table, Jev's check on changes)
//   moderated  the moderator wraps up on convergence, calls a devil's advocate, pauses when circling
//   notes      what the discussion's notes are for: a short numbered list the members keep themselves ([NOTE] lines)
//              and every turn sees, so a long discussion or story doesn't drift from what was established
// Everything in this file is pure.

export const MODES = {
  research: {
    label: '研究', flow: 'free', stance: true, moderated: true, blindOpening: true,
    notes: { title: '资料与结论', keep: 'facts and sources established so far, and conclusions the group reached' },
    prompt: 'Discussion mode: RESEARCH. Establish the facts first, then discuss interpretation. Say clearly what is fact, '
      + 'inference, opinion or prediction; verify factual claims with your tools when you can and cite sources; challenge '
      + 'evidence and assumptions rather than manufacturing disagreement; state how uncertain you are; do not debate for '
      + 'entertainment.',
  },
  roundtable: {
    label: '圆桌', flow: 'free', stance: true, moderated: true,
    notes: { title: '要点', keep: 'key points, agreements and open questions' },
    prompt: 'Discussion mode: ROUNDTABLE. Explore the problem from several useful perspectives. Do not force yourselves into '
      + 'opposing camps; surface missing perspectives, assumptions, trade-offs, edge cases and failure modes; respond to '
      + 'specific points others made; consensus is fine when it is warranted; do not repeat summaries of what was already said.',
  },
  debate: {
    label: '辩论', flow: 'debate',
    notes: { title: '事实、类比与金句', keep: 'key facts, telling analogies and memorable lines from either side' },
    prompt: 'Discussion mode: DEBATE. A formal debate with assigned sides, then free discussion.',
  },
  story: {
    label: '故事', flow: 'relay',
    notes: { title: '设定', keep: 'characters and how they relate to each other, world rules, and key events so far' },
    prompt: 'Discussion mode: STORY RELAY. The members write one story together, one passage per turn. Continue exactly '
      + 'from the latest passage, keep every established character, relationship and fact (see the notes), and when the '
      + 'user interjects, weave it into the story. Write the passage itself (up to about 300 Chinese characters), no '
      + 'commentary or summary, never PASS. You may end by @mentioning who takes the baton next.',
  },
};

// After the formal debate the room talks freely, under roundtable rules.
export const rulesOf = (mode, debate) => (mode === 'debate' && debate?.done ? { ...MODES.roundtable, label: MODES.debate.label,
  notes: MODES.debate.notes, prompt: `${MODES.roundtable.prompt} The formal debate is over: you are no longer bound to `
    + 'your assigned side; say what you actually think.' } : MODES[mode]);

// ---------- story relay ----------
// The baton goes to the member the latest message @mentioned, else to the next member after `after` (display order).
export function relayNext(order, after, mentioned) {
  if (mentioned && order.includes(mentioned) && mentioned !== after) return mentioned;
  return order[(order.indexOf(after) + 1) % order.length]; // indexOf -1 (nobody yet) → the first member
}

// ---------- debate ----------
const SIDE = { pro: '正方', con: '反方' };
const NUM = ['一', '二', '三', '四', '五', '六', '七', '八'];
export const PHASES = { opening: '开篇立论', rebuttal: '驳论', free: '自由辩', closing: '结辩', verdict: '评判' };

// Sides at random. With an odd number of members one of them judges; with an even number the user does.
export function debateSetup(names, rand = Math.random) {
  const s = [...names];
  for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
  const judge = s.length % 2 ? s.pop() : 'user';
  return { pro: s.slice(0, s.length / 2), con: s.slice(s.length / 2), judge, at: 0, done: false };
}

export const seatOf = (d, name) => (name === d.judge ? '评委'
  : ['pro', 'con'].map(side => d[side].indexOf(name) >= 0 && `${SIDE[side]}${NUM[d[side].indexOf(name)]}辩`).find(Boolean) || null);

// The order of play, loosely after a debate tournament: openings, rebuttals by the other debaters, a free exchange
// alternating sides (who speaks is picked when the slot comes up), closings (con first), then the verdict.
export function debateScript({ pro, con, judge }) {
  const seat = (side, i) => ({ side, who: (side === 'pro' ? pro : con)[i] });
  const last = pro.length - 1;
  return [
    { phase: 'opening', ...seat('pro', 0) }, { phase: 'opening', ...seat('con', 0) },
    ...pro.slice(1).flatMap((_, i) => [{ phase: 'rebuttal', ...seat('pro', i + 1) }, { phase: 'rebuttal', ...seat('con', i + 1) }]),
    ...Array.from({ length: 2 * pro.length }, (_, i) => ({ phase: 'free', side: i % 2 ? 'con' : 'pro' })),
    { phase: 'closing', ...seat('con', last) }, { phase: 'closing', ...seat('pro', last) },
    { phase: 'verdict', who: judge },
  ];
}

const PHASE_GUIDE = {
  opening: 'Lay out your side\'s case: how you read the motion, your criteria and your main arguments.',
  rebuttal: 'Take apart the other side\'s case so far, then strengthen your own.',
  free: 'A short, pointed exchange: answer the other side\'s latest point and land one of your own.',
  closing: 'Sum up why your side wins, answering the other side\'s strongest point.',
};
// What a member is told about its part in the debate (kept loose: who it is and roughly where the debate stands).
export function debateBrief(d, name, phase, motion, handle) {
  const list = side => d[side].map(handle).join(', ');
  const judge = d.judge === 'user' ? 'the user' : handle(d.judge);
  if (name === d.judge) return `Debate on the motion: "${motion}". You are the judge (评委). Pro: ${list('pro')}. Con: ${list('con')}.\n`
    + 'The debate is over. Decide which side argued better and why (cite #N), name the best debater, and say in a line '
    + 'what each side missed. After your verdict the floor opens for free discussion.';
  const side = d.pro.includes(name) ? 'pro' : 'con';
  return `Debate on the motion: "${motion}". You are ${seatOf(d, name)}, on the ${side === 'pro' ? 'pro side (for' : 'con side (against'} `
    + `the motion). Pro: ${list('pro')}. Con: ${list('con')}. Judge: ${judge}.\nNow: ${PHASES[phase]}. ${PHASE_GUIDE[phase]} `
    + 'Your side is assigned, not your own view: argue it as well as you can, and answer the user if they interjected.';
}

// ---------- the reply protocol ----------
// A reply may end with note lines, then "[STANCE 70%] verdict: position" (confidence 0-100), then [HAND]:
//   [NOTE add] text      [NOTE edit N3] text      [NOTE drop N3]
// Returns {text, hand, stance: {t, c, l?} | null, notes: [{op, n?, text?}]}; those lines are removed from the text.
const STANCE = /^[ \t>*_]*\[(?:STANCE|立场)\s*[:：]?\s*(\d{1,3})\s*%?\][ \t*_:：]*(.*)$/im;
const NOTE = /^[ \t>*_-]*\[NOTE\s+(add|edit|drop)(?:\s+N?(\d+))?\][ \t*_:：]*(.*)$/gim;
export function parseReply(raw) {
  const notes = [];
  const tail = /\[HAND\]\s*$/.test(raw.trim()); // [HAND] goes last, but may come before the note/stance lines too
  let text = raw.replace(NOTE, (_, op, n, t) => {
    t = t.replace(/\[HAND\]/g, '').trim();
    op = op.toLowerCase();
    if (op === 'add' ? t : n && (op === 'drop' || t)) notes.push({ op, ...(n && { n: +n }), ...(op !== 'drop' && { text: t.slice(0, 300) }) });
    return '';
  });
  let stance = null;
  const m = text.match(STANCE);
  if (m) {
    text = text.replace(m[0], '');
    const t = m[2].replace(/\[HAND\]/g, '').replace(/^[\s*_]+|[\s*_]+$/g, '');
    // The position may start with a short verdict label ("条件支持：…"), kept as l.
    const lt = t.match(/^([^：:，,。]{1,8})[：:]\s*(.+)$/);
    if (t) stance = { t: (lt ? lt[2] : t).slice(0, 300), c: Math.min(100, +m[1]), ...(lt && { l: lt[1].trim() }) };
  }
  text = text.trim();
  const hand = tail || /\[HAND\]\s*$/.test(text);
  // Agents sometimes write a reply and then a stray "PASS" on its own last line: drop it (a bare PASS stays a pass).
  text = text.replace(/\s*\[HAND\]\s*$/, '').trim().replace(/\n\s*PASS[.。!！]?$/i, '').trim();
  return { text, hand, stance, notes };
}

// Applies note ops to a list [{n, text, ...}]: returns the ops that changed something, with the numbers they got.
export function applyNotes(list, ops, meta = {}) {
  const done = [];
  for (const o of ops) {
    const i = list.findIndex(x => x.n === o.n);
    if (o.op === 'add') { const n = Math.max(0, ...list.map(x => x.n)) + 1; list.push({ n, text: o.text, ...meta }); done.push({ op: 'add', n }); }
    else if (i >= 0 && o.op === 'edit') { list[i] = { ...list[i], text: o.text, ...meta }; done.push({ op: 'edit', n: o.n }); }
    else if (i >= 0 && o.op === 'drop') { list.splice(i, 1); done.push({ op: 'drop', n: o.n }); }
  }
  return done;
}
