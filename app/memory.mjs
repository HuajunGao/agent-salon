// Cross-discussion memory about the user: a short, user-editable list of durable facts (data/memory.md).
// After a round goes quiet, a configured member merges what the user newly said into it.
import { runTurn } from './agents.mjs';

const MAX_BULLETS = 30;

// The memory goes to every member (every model provider) at the start of every discussion, and stays there.
const PRIVACY = `Privacy: this memory is sent to AI models from several providers in every new discussion. Never record
exact amounts of money (balances, income, prices paid, net worth), individual transactions or merchants, account
numbers, financial institutions, addresses, employers, health details, or other people's names. Keep at most the
general shape, e.g. "invests mostly in ETFs, about a third in cash", "renting in Sydney".`;

const BULLET_FORMAT = `One line each, starting with "- " and ending with the source message number(s) and the month the
user last said it, like (#74, 2026-10).`;

// userMsgs: [{id, text, chat, created_at}] written by the user since the last curation. Returns {text} (new memory),
// {unchanged: true}, or {error}.
export async function curate(memory, userMsgs, { language, cwd, dataDir, harness, model, member, signal }) {
  const byChat = Map.groupBy(userMsgs, m => m.chat);
  const news = [...byChat].map(([chat, ms]) => `Discussion "${chat}":\n`
    + ms.map(m => `- #${m.id} (${(m.created_at || '').slice(0, 10)}): ${m.text}`).join('\n')).join('\n\n');
  const ask = prompt => runTurn(harness, prompt, null, { cwd, dataDir, model, member, signal, onLive() {} });
  const bulletsOf = text => text.split('\n').map(l => l.trim()).filter(l => l.startsWith('- '));
  const r = await ask(`You maintain a short memory about one person: the user of a group chat with several AI agents.
The agents read this memory at the start of every new discussion, so it should help them understand who they talk to.

Current memory:
${memory.trim() || '(empty)'}

Messages the user wrote since the last update (with dates):
${news}

Update the memory. Keep durable facts about the user that will still matter in later discussions: background and role,
projects, environment and stack, constraints, preferences and opinions, and how they like answers. Leave out the
discussion topics themselves, one-off questions, and anything about the agents. Merge duplicates; when a new message
contradicts an old fact, keep the newer one; when a new message confirms an old fact, update its month.
At most ${MAX_BULLETS} bullets: when there would be more, merge related facts into broader ones and drop those least
likely to matter, oldest-confirmed first.
${PRIVACY}
${BULLET_FORMAT} Write in ${language}.
If nothing durable is new, answer exactly NO_CHANGE. Otherwise output only the full updated list of bullets.`);
  if (r.error) return { error: r.error };
  if (/^NO_CHANGE\b/.test(r.text.trim())) return { unchanged: true };
  let bullets = bulletsOf(r.text);
  if (!bullets.length) return { error: `unexpected curator output: ${r.text.slice(0, 120)}` };
  // Still too long: one compression pass instead of silently cutting whatever came last.
  if (bullets.length > MAX_BULLETS) {
    const c = await ask(`This memory about a user has ${bullets.length} bullets; the limit is ${MAX_BULLETS}. Merge related
facts into broader ones and drop those least likely to matter, oldest-confirmed first. Keep the sources and months.
${PRIVACY}
${BULLET_FORMAT} Write in ${language}. Output only the list.

${bullets.join('\n')}`);
    const shorter = c.error ? [] : bulletsOf(c.text);
    if (shorter.length) bullets = shorter;
  }
  return { text: bullets.slice(0, MAX_BULLETS).join('\n') + '\n' };
}
