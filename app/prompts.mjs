// What a member is told in a chat turn: the session intro (rules, members, archive, memory) and each turn's ask
// (by flow: free discussion, relay, debate, game; summary, devil's advocate …), plus the discussion's notes.
import { join } from 'node:path';
import { hostBrief, playerBrief } from './game.mjs';
import { debateBrief, seatOf } from './modes.mjs';
import { q1 } from './db.mjs';
import { WORK, SHARED, PUBLIC, JOBS, ARCHIVE, wsOf, avatarOf, readMemory } from './workspace.mjs';
import { S, memberConfigs, memberOrder, enabledOrder, atOf, handle, replyLang, wURL } from './config.mjs';
import { chatState, rules, describe, nickOf, archiveFile } from './chats.mjs';
import { TASK_MS } from './jobs.mjs';

// Codex reads files only through shell commands and runs in a read-only sandbox; the others have file tools,
// and headless agy ends its turn with no reply when a command is denied.
export const SHELL_RULE = {
  codex: 'Your sandbox is read-only: read-only shell commands (cat, rg, ls) are fine for reading files.',
  default: "Don't run shell commands (they are denied, and a denied action ends your turn without a reply).",
};
export const shellRule = a => SHELL_RULE[memberConfigs[a].harness] || SHELL_RULE.default;
const toolRule = (a, exec) => (exec
  ? `You have your own workspace, ${wsOf(a)} (your current directory): you may create files and run code there to check a
  claim, e.g. a small script, a quick benchmark, or installing a package locally. Keep it quick: a turn should finish within
  a couple of minutes. Stay inside your workspace; the discussion files are read-only for you.
  Projects the members build together (when the user asks for one) go in the shared git repo ${SHARED}: run
  \`git log\` and \`git status\` first to see what others did. After each of your turns the server commits what changed
  there with you as the author (files over 500 KB stay uncommitted); commit yourself when a clearer message helps. For a
  big change that could collide with others' work, use a branch or \`git worktree add\` in your own workspace and merge back.
  Python: use the shared environment ${SHARED}/.venv (create it with \`uv venv\` if it is missing, install with
  \`uv pip install\`, record dependencies in requirements.txt), not a private one. Files in ${PUBLIC} are served at
  ${wURL()} (e.g. ${PUBLIC}/arena/index.html → ${wURL()}arena/index.html): give the user those links, and don't start
  web servers of your own.
  You exist only during your turns: once your reply is sent, nothing of yours runs until you are woken again, and
  processes you started end with the turn. So never say you will now go and do something ("我这就去跑…") unless you
  started it as a job or task below: do it in this turn and report the result, or say it waits for your next turn.
  For anything longer, put one of these on a line of its own in your reply (the line is taken out of your message):
  \`[JOB] <shell command>\` runs a command in the background as you (cwd: your workspace; a tournament, a long build or
  benchmark), logging to ${JOBS}/J<id>.log. \`[TASK] <what to do>\` starts a background coding session of your own (your
  CLI and model, up to ${TASK_MS / 60e3} minutes, no chat) in your workspace; \`[TASK shared] <what to do>\` does it in a
  git worktree of the shared repo and merges it back when done, so several members can work on the shared code at once.
  Describe the task fully: it sees only the description and the last messages. Meanwhile you keep chatting. When a job
  or task ends the chat is told and you are woken with its result (a task's summary, a job's log tail). At most one task
  of yours at a time; a server restart stops what is running, so make long jobs resumable (save results as you go).`
  : `The discussion is read-only: don't create, edit or delete files. ${shellRule(a)}`);

export function intro(a, chat, exec) {
  const memory = S.memory ? readMemory().trim() : '';
  return `You are ${describe(a)}, one member of a live group chat running on the user's machine.
Members: the user (a human, full participant) and the participating agents ${memberOrder().filter(n => S.enabled[n]).map(describe).join(', ')}.
${memberConfigs[a]?.persona ? `Your role: ${memberConfigs[a].persona}` : ''}
Each turn you receive the messages you haven't seen yet, numbered #N. Your reply is posted to the chat as one message.
Rules:
- This is a chat, not a report: keep each message short (usually under 150 words / 300 Chinese characters), one or two points, no headings.
- Say something new: build on, question or disagree with specific messages and cite them (#N). Don't repeat what others said.
- The user is a participant: when the user has spoken, engage with their points first.
- If you have nothing worth adding right now, answer exactly PASS. If a message @mentions someone else and not you, usually PASS.
- To speak again after others respond, end your message with [HAND]. To ask a member something, @mention them.
- You may search the web, read web pages and read files to inform the discussion. ${toolRule(a, exec)}
- The user may attach files or images; their paths come with the message. Open them with your file tools (images too,
  if you can see images); if you can't open one, say so rather than guess what it contains.
- To attach a file or image to your message (the user sees images inline, the others get its path), put \`[FILE] <path>\`
  on a line of its own: a file under ${WORK}, absolute or relative to your workspace; up to 4, 20 MB each.
- Avatars: each member's avatar, shown next to its messages, is avatar.png (or .jpg / .webp / .gif) in its workspace:
  ${memberOrder().filter(n => S.enabled[n]).map(n => `@${atOf(n)} ${avatarOf(n) || `${join(wsOf(n), 'avatar.png')} (none yet)`}`).join(', ')}.
  ${exec ? 'You may draw or generate your own (square, about 256-512 px) and save it there; leave the others\' alone.' : 'You can\'t change yours in a read-only discussion.'}
- This discussion's full transcript is ${archiveFile(chat)}. Earlier discussions are archived in ${ARCHIVE}: index.md lists
  them with their conclusions, <id>.md is one discussion. When the user refers to something discussed before, look it up
  there (read / search the files) instead of guessing.
${memory ? `\nWhat you know about the user from earlier discussions (a curated memory; it may be outdated, and what the user
says now wins):\n${memory}\n` : ''}\n`;
}

export function notesPrompt(c) {
  const { notes = [] } = chatState(c), r = rules(c);
  return `\nThe discussion's notes (${r.notes.title}: ${r.notes.keep}). Stay consistent with them:\n`
    + (notes.map(x => `N${x.n} ${x.text}`).join('\n') || '(none yet)')
    + `\nTo keep them current you may add lines at the end of your message: [NOTE add] <text> / [NOTE edit N2] <text> / `
    + `[NOTE drop N2]. Change them sparingly: add only what later turns must stay consistent with, edit or drop only to `
    + `correct them. Most turns change nothing.`;
}

// What this turn is asked to do, by flow. Sent every turn (not only in the session intro): the mode can change.
const STANCE_RULE = `\nEnd your message with one line: [STANCE n%] verdict: your current position on the question in one `
  + `short sentence. n = your confidence (0-100); verdict = 2-6 characters such as 支持 / 反对 / 条件支持 / 中立, or the `
  + `option you pick (e.g. 选 Go). Keep your position unless an argument or fact actually convinces you; when it `
  + `changes, say what convinced you (#N).`;
export function turnAsk(a, chat, { r, d, phase, k, n, floor, summary, invited, blind, role, play, exec }) {
  const tools = exec ? `You may run code in your workspace ${wsOf(a)} to check claims, or work in the shared repo ${SHARED}; keep it quick.`
    : memberConfigs[a].harness === 'codex' ? 'Read-only commands only.' : 'No shell commands: use web search, web pages and file reading only.';
  const roster = `\nCurrent participating members (${enabledOrder().length}): ${enabledOrder().map(describe).join(', ')}. `
    + 'This roster overrides earlier rosters. Use these exact @handles when addressing them (@names work too). '
    + (nickOf(a, chat) ? `Your name here is ${nickOf(a, chat)}; a line [NAME] <name> changes it if your role or mood changes.`
      : 'Give yourself a name for this discussion: a line [NAME] <name> (up to 12 characters, no spaces). Have fun with it, '
        + 'pick one that fits your character, role or stance here; it shows next to your messages and others can @ you by it.');
  const reply = `(Reply in ${replyLang()}. Short chat message. Answer exactly PASS if you have nothing new. End with [HAND] to speak again later. ${tools})`;
  if (summary) return `\n\nThe moderator judged that the discussion has converged. Write a short summary for the user: `
    + `the conclusion, who agreed (cite #N), and caveats still open. No new arguments, no @mentions, no [HAND].\n\n${reply}${roster}`;
  let ask;
  const g = r.flow === 'game' && chatState(chat).game;
  if (r.flow === 'relay') ask = `\n\n(Your turn in the relay. Reply in ${replyLang()}. ${tools})\n${r.prompt}`;
  else if (g) ask = `\n\n${!g.host ? 'The game is over: talk about it in public.' // an old built-in game
    : a !== g.host ? playerBrief(g, a, play?.phase || 'over', handle, exec)
    : play?.phase === 'host' ? hostBrief(g, handle, exec, !g.round) : 'You hosted the game, which is over: talk about it in public.'}`
    + `\n\n(Reply in ${replyLang()}. ${tools})\n${r.prompt}`;
  else if (r.flow === 'debate' && d && !d.skipped && seatOf(d, a)) {
    const motion = q1('SELECT text FROM messages WHERE id=?', d.motion)?.text || '';
    ask = `\n\n${debateBrief(d, a, phase || d.script[d.at]?.phase || 'free', motion, x => `@${atOf(x)}`)}\n(Reply in ${replyLang()}. ${tools})`;
  } else {
    ask = `\n\n(Your turn ${k} of at most ${S.turnCap} since the user's last message; ${n} new message(s).`
      + (k >= S.turnCap && !floor ? ' This is your last turn here: PASS unless something essential is missing.)' : ')');
    if (role === 'devil') ask += `\n\nThe moderator asks you to play devil's advocate: the group agreed quickly and nobody `
      + `pushed back. Argue the strongest case against the emerging consensus, concretely (cite #N): when would it be wrong, `
      + `what does it cost, what is the best alternative? Say briefly that you are taking the opposing side on request.`;
    else if (floor) ask += `\n\nThe user has given you the floor: please speak now.`;
    if (invited) ask += `\n\nThe moderator invited you to speak: you seem to have something new to add here.`;
    if (blind) ask += `\n\nIndependent opening: every member is answering this question at the same time without seeing the `
      + `others' answers, so the group first hears independent views. Give your own answer and your reasons; don't PASS.`;
    ask += `\n\n${reply}${r.stance ? STANCE_RULE : ''}\n${r.prompt}`;
  }
  return ask + notesPrompt(chat) + roster;
}
