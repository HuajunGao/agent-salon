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

async function ask(messages, questions) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return { error: 'TYPESAFE_API_KEY not set' };
  const model = process.env.TYPESAFE_MODEL;
  if (!model) return { error: 'TYPESAFE_MODEL not set' };
  const state = { discussion: { question: messages[0].text,
    messages: messages.map(m => ({ id: m.id, from: m.sender === 'user' ? 'user' : `@${m.sender}`, text: m.text })) } };
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
