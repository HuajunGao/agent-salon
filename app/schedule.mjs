// The scheduler's arithmetic, without state (room.mjs gathers the inputs): who scores highest among raised hands,
// and how long a published message holds the next one.

// Fairness modifies priority, it doesn't decide it: score = relevance × fairness × freshness − cooldown.
// hand: {r, since, why}; nov: Jev's novelty (0-1, 0.5 = neutral) or null; silence: messages since the member last spoke
// (-1: not in the last 50); sinceUser: its turns since the user's last message.
export function scoreHand({ hand: h, nov = null, silence, sinceUser, now = Date.now() }) {
  const fairness = 1 + 0.1 * Math.min(silence < 0 ? 10 : silence, 10); // capped: silence helps, but only so much
  const freshness = 1 / (1 + (now - h.since) / 300e3);                // hands decay over minutes
  const cooldown = (silence >= 0 && silence < 2 ? 0.4 : 0) + 0.2 * sinceUser;
  const relevance = nov == null ? h.r : h.r * 2 * nov;
  const s = relevance * fairness * freshness - cooldown;
  return { s, r: h.r, why: h.why, nov, relevance: +relevance.toFixed(2), fairness: +fairness.toFixed(2),
    freshness: +freshness.toFixed(2), cooldown, sinceUser };
}

// Reading speed is in Chinese characters per minute, so count what a reader actually reads: each CJK character
// is 1 unit, each English word / number / identifier ~1.5 (400 字/min ≈ 250 words/min); spaces, punctuation and
// markdown don't count. (text.length counted every Latin letter and symbol: ~50% too long on technical replies.)
export const readUnits = text => (text.match(/[぀-ヿ㐀-鿿가-힯豈-﫿]/g) || []).length
  + 1.5 * (text.match(/[A-Za-z0-9][A-Za-z0-9_.\-\/]*/g) || []).length;
export const readMs = (text, speed) => Math.max(3000, (readUnits(text) / speed) * 60e3);

// Whether the publish queue may release the next reply now (force: the user's "next").
export const mayPublish = ({ readUntil, typingAt, speakingAt }, paused, now = Date.now()) =>
  !(now < readUntil || now - typingAt < 15e3 || now - speakingAt < 20e3 || paused);
