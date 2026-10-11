import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreHand, readUnits, readMs, mayPublish } from './schedule.mjs';

test('score: relevance × fairness × freshness − cooldown; fairness only nudges', () => {
  const now = 1e9, hand = { r: 1, since: now, why: 'user message' };
  // never spoke (not in the last 50): the full fairness bonus, no cooldown
  assert.equal(scoreHand({ hand, silence: -1, sinceUser: 0, now }).s, 2);
  // just spoke: no bonus, the just-spoke cooldown and one turn since the user
  assert.equal(+scoreHand({ hand, silence: 0, sinceUser: 1, now }).s.toFixed(2), 0.4);
  // silence is capped at 10 messages
  assert.equal(scoreHand({ hand, silence: 30, sinceUser: 0, now }).s, scoreHand({ hand, silence: 10, sinceUser: 0, now }).s);
  // a user @mention (r 10) outranks the quietest plain hand
  assert.ok(scoreHand({ hand: { ...hand, r: 10 }, silence: 0, sinceUser: 2, now }).s > scoreHand({ hand, silence: -1, sinceUser: 0, now }).s);
  // hands decay: after 5 minutes half as fresh
  assert.equal(scoreHand({ hand: { ...hand, since: now - 300e3 }, silence: -1, sinceUser: 0, now }).freshness, 0.5);
  // Jev's novelty scales relevance around 0.5 (neutral)
  assert.equal(scoreHand({ hand, nov: 0.5, silence: -1, sinceUser: 0, now }).s, 2);
  assert.equal(scoreHand({ hand, nov: 0.1, silence: -1, sinceUser: 0, now }).relevance, 0.2);
});

test('reading time counts what a reader reads, at least 3 s', () => {
  assert.equal(readUnits('你好，世界'), 4);
  assert.equal(readUnits('use node:sqlite in v22.5 **now**'), 1.5 * 6); // markdown and punctuation don't count
  assert.equal(readMs('短', 400), 3000);
  assert.equal(readMs('字'.repeat(800), 400), 120e3);
});

test('the queue holds while the reader reads, types, listens or paused', () => {
  const now = 1e9, idle = { readUntil: 0, typingAt: 0, speakingAt: 0 };
  assert.equal(mayPublish(idle, false, now), true);
  assert.equal(mayPublish(idle, true, now), false);
  assert.equal(mayPublish({ ...idle, readUntil: now + 1 }, false, now), false);
  assert.equal(mayPublish({ ...idle, typingAt: now - 14e3 }, false, now), false);
  assert.equal(mayPublish({ ...idle, typingAt: now - 16e3 }, false, now), true);
  assert.equal(mayPublish({ ...idle, speakingAt: now - 19e3 }, false, now), false);
});
