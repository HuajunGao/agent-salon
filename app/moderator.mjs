// TypeSafe Jev as a cheap moderator. Key stays server-side (TYPESAFE_API_KEY).
const QUESTIONS = {
  convergence: { type: 'score',
    instructions: "How far have the participants in `discussion.messages` converged on an answer to the user's question `discussion.question` (judge the latest positions, not the early ones)?",
    criteria: [
      'Open disagreement: participants hold different main positions and are still arguing for them.',
      'Partial convergence: some agreement, but at least one participant still holds a different main position or a key point is still disputed.',
      'Mostly converged: participants give the same main answer, but still differ on a secondary point that matters for the user (e.g. which option to pick, or a significant risk).',
      'Fully converged: every participant gives the same main answer (stated independently or by agreeing with others); remaining differences are only wording, extra examples or minor optional tips, and nobody disputes it.'] },
  stalling: { type: 'noul',
    instructions: 'Do the last few messages in `discussion.messages` mostly agree with or restate earlier points, without adding a new argument, fact, risk or proposal?',
    criteria: { true: 'Recent messages add nothing substantive: agreement, restatement, summaries of what was said.',
      false: 'Recent messages still add new substance.' } },
  // For devil's advocate: only on judgment questions, and only if nobody has really pushed back yet.
  debatable: { type: 'noul',
    instructions: "Is the user's question `discussion.question` a matter of judgment or trade-offs on which reasonable experts could disagree?",
    criteria: { true: 'Judgment call: design choices, priorities, practices, opinions, trade-offs with no single correct answer.',
      false: 'Factual question with one correct answer that can be looked up or checked (e.g. what a format or tool supports).' } },
  challenged: { type: 'noul',
    instructions: 'In `discussion.messages`, did any participant seriously challenge or argue against the answer most participants now hold?',
    criteria: { true: 'Someone argued for a different answer or raised a substantial objection that had to be addressed.',
      false: 'Participants mostly agreed from the start; differences were only additions, examples or caveats.' } },
  circling: { type: 'noul',
    instructions: 'Is the discussion in `discussion.messages` going in circles: the latest messages repeat arguments already made earlier, back and forth, without new information or progress toward agreement?',
    criteria: { true: 'Same disagreement restated in new words; positions are not moving and nothing new is added.',
      false: 'The discussion is still making progress, or is simply converging.' } },
};

async function ask(messages, questions, extra = {}) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return { error: 'TYPESAFE_API_KEY not set' };
  const model = process.env.TYPESAFE_MODEL;
  if (!model) return { error: 'TYPESAFE_MODEL not set' };
  const state = { discussion: { question: messages[0].text,
    messages: messages.map(m => ({ id: m.id, from: m.sender === 'user' ? 'user' : `@${m.sender}`, text: m.text })) }, ...extra };
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', signal: AbortSignal.timeout(20e3),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
    });
    if (!r.ok) return { error: `jev ${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { answers: (await r.json()).answers, ms: Date.now() - t0 };
  } catch (e) { return { error: `jev: ${e.message}` }; }
}

// messages: the user's latest message and everything after it.
// Returns {convergence, stalling, debatable, challenged, circling (all 0..1), ms} or {error}.
export async function judge(messages) {
  const r = await ask(messages, QUESTIONS);
  if (r.error) return r;
  const a = r.answers;
  return { convergence: a.convergence.score / 3, stalling: a.stalling.noul, debatable: a.debatable.noul,
    challenged: a.challenged.noul, circling: a.circling.noul, ms: r.ms };
}

// Relevance/novelty for the scheduler: would each candidate add something new if it spoke next?
// agents: [{name, harness, model}]. Returns {novelty: {name: 0..1}, ms} or {error}.
export async function novelty(messages, agents) {
  const questions = Object.fromEntries(agents.map(a => [a.name, { type: 'noul',
    instructions: {
      candidate: { handle: `@${a.name}`, runs: `${a.harness} with model ${a.model}` },
      question: 'If `candidate` spoke next in `discussion`, would it likely add something new and useful: answer a point or '
        + 'question addressed to it, disagree with or correct a claim, or add a missing fact, risk or alternative?',
    },
    criteria: {
      true: 'Likely adds substance: it was addressed, has not given its view yet, or there is a disputed or missing point it can take up.',
      false: 'Likely repeats what was said: its view is already stated and nothing new is addressed to it or left open for it.',
    } }]));
  const r = await ask(messages, questions);
  return r.error ? r : { novelty: Object.fromEntries(agents.map(a => [a.name, r.answers[a.name].noul])), ms: r.ms };
}

// Discussion mode for a topic (Auto mode): one Choice over the user's question. Returns {mode, probabilities, ms} or {error}.
export async function classifyMode(question) {
  const r = await ask([{ id: 0, sender: 'user', text: question }], { mode: { type: 'choice',
    instructions: 'Which kind of group discussion does the user\'s question `discussion.question` call for?',
    criteria: {
      research: { use_when: 'Current facts, evidence, data, external verification, or uncertainty about the real world are central.',
        examples: ['What do you think about an RBA rate hike in November?', 'Is AI coding actually reducing developer hiring?'] },
      roundtable: { use_when: 'Mainly trade-offs, architecture, design choices, interpretation or expert judgment, without two naturally opposing sides.',
        examples: ['When should a monolith be split into microservices?', 'How should we structure a company engineering knowledge base?'] },
      debate: { use_when: 'A normative choice, a value conflict, or clear opposing positions that can both be meaningfully defended.',
        examples: ['A pill removes the need to sleep. Should society deploy it?', 'You receive life advice from yourself 30 years in the future. Do you read it?'] },
    } } });
  if (r.error) return r;
  return { mode: r.answers.mode.choice, probabilities: r.answers.mode.probabilities, ms: r.ms };
}

// Did a member's stance really change, and was it moved by substance or by the majority? `messages` run from the user
// question before the earlier stance to the new message; before/after: {t, c}. Returns {changed, evidence, ms} or {error}.
export async function stanceShift(messages, member, before, after) {
  const r = await ask(messages, {
    changed: { type: 'noul',
      instructions: '`shift.member` stated its position on `discussion.question` earlier as `shift.before` and now as `shift.after`. Is the main position different, not just refined?',
      criteria: { true: 'A different main answer: switched sides, reversed or substantially changed its recommendation.',
        false: 'The same main answer, possibly with more detail, a caveat, a different confidence or other wording.' } },
    evidence: { type: 'noul',
      instructions: 'Between its two statements, did `shift.member` receive in `discussion.messages` a specific new fact, source, counterexample or argument that justifies moving from `shift.before` toward `shift.after`, rather than going along with what most others said?',
      criteria: { true: 'Someone gave it new substance that supports the move.',
        false: 'No new substance: the move follows agreement, repetition or the majority.' } },
  }, { shift: { member: `@${member}`, before: `${before.t} (confidence ${before.c}%)`, after: `${after.t} (confidence ${after.c}%)` } });
  return r.error ? r : { changed: r.answers.changed.noul, evidence: r.answers.evidence.noul, ms: r.ms };
}

// A reply ends with "[STANCE 70%] the member's position in one sentence" (confidence 0-100), then optionally [HAND].
// Returns {text, hand, stance: {t, c} | null}; the stance line is removed from the text.
const STANCE = /^[ \t>*_]*\[(?:STANCE|立场)\s*[:：]?\s*(\d{1,3})\s*%?\][ \t*_:：]*(.*)$/im;
export function parseReply(raw) {
  let text = raw, stance = null;
  const m = text.match(STANCE);
  if (m) {
    text = text.replace(m[0], m[2].includes('[HAND]') ? '[HAND]' : '');
    const t = m[2].replace(/\[HAND\]/g, '').replace(/^[\s*_]+|[\s*_]+$/g, '');
    if (t) stance = { t: t.slice(0, 300), c: Math.min(100, +m[1]) };
  }
  text = text.trim();
  const hand = /\[HAND\]\s*$/.test(text);
  // Agents sometimes write a reply and then a stray "PASS" on its own last line: drop it (a bare PASS stays a pass).
  text = text.replace(/\s*\[HAND\]\s*$/, '').trim().replace(/\n\s*PASS[.。!！]?$/i, '').trim();
  return { text, hand, stance };
}
