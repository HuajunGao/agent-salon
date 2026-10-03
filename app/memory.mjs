// Cross-discussion memory about the user: a short, user-editable list of durable facts (data/memory.md).
// After a round goes quiet, a cheap model merges what the user newly said into it.
import { runTurn } from './agents.mjs';

const MAX_BULLETS = 30;

// userMsgs: [{id, text, chat}] written by the user since the last curation. Returns {text} (new memory),
// {unchanged: true}, or {error}.
export async function curate(memory, userMsgs, { language, cwd, dataDir }) {
  const byChat = Map.groupBy(userMsgs, m => m.chat);
  const news = [...byChat].map(([chat, ms]) => `Discussion "${chat}":\n` + ms.map(m => `- #${m.id}: ${m.text}`).join('\n')).join('\n\n');
  const prompt = `You maintain a short memory about one person: the user of a group chat with several AI coding agents.
The agents read this memory at the start of every new discussion, so it should help them understand who they talk to.

Current memory:
${memory.trim() || '(empty)'}

Messages the user wrote since the last update:
${news}

Update the memory. Keep durable facts about the user that will still matter in later discussions: background and role,
projects, environment and stack, constraints, preferences and opinions, and how they like answers. Leave out the
discussion topics themselves, one-off questions, and anything about the agents. Merge duplicates; when a new message
contradicts an old fact, keep the newer one. At most ${MAX_BULLETS} bullets, one line each, starting with "- " and ending
with the source message number like (#74). Write in ${language}.
If nothing durable is new, answer exactly NO_CHANGE. Otherwise output only the full updated list of bullets.`;
  const r = await runTurn('claude', prompt, null, { cwd, dataDir, model: 'haiku', onLive() {} });
  if (r.error) return { error: r.error };
  if (/^NO_CHANGE\b/.test(r.text.trim())) return { unchanged: true };
  const bullets = r.text.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).slice(0, MAX_BULLETS);
  return bullets.length ? { text: bullets.join('\n') + '\n' } : { error: `unexpected curator output: ${r.text.slice(0, 120)}` };
}
