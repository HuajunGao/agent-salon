# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A local "agent group chat": the user asks a question and configurable members, each using a CLI harness and model,
discuss it in a web UI, paced for human reading, with TypeSafe as a moderator. PLAN.md holds the
design decisions, the hard-won CLI details and the home-server deployment notes; read the relevant section before
changing scheduling, adapters or deployment. The user communicates in Chinese; UI text and agent prompts' output
language follow the `language` setting (default 中文).

## Commands

No npm dependencies, no build step (the UI's Markdown renderer, marked, is vendored as `app/vendor/marked.umd.js`;
raw HTML in messages is escaped and only http(s)/mailto links are kept). Node ≥ 22.5 (uses built-in `node:sqlite`).

- Run locally: `node app/server.mjs` → http://localhost:3517 (`PORT`, `HOST` env; `.claude/launch.json` has a preview config)
- Syntax check: `for f in app/*.mjs app/ui.js; do node --check "$f"; done`
- Tests (real server + SQLite, fake harness, no paid calls): `node --test app/schedule.test.mjs app/members.test.mjs app/modes.test.mjs app/speech.test.mjs app/stance.test.mjs app/env.test.mjs app/flows.test.mjs`.
  The server tests copy the app with `testkit.mjs` `copyApp` (every module but `agents.mjs`, which each test fakes), so a
  new module needs no test change; `restart()` in flows.test.mjs restarts the server on the same data.
  Verify adapters by importing them directly, e.g.
  `node -e 'import("./app/agents.mjs").then(async m => console.log(await m.runTurn("codex", "1+1?", null, {cwd: "workspace", dataDir: "data", onLive(){}})))'`
  (a second call with the returned `sid` checks session resume). `moderator.mjs` `judge`/`novelty` and `memory.mjs`
  `curate` can be exercised the same way; Jev needs `TYPESAFE_API_KEY`.
- Deploying, server logs, instances: read `DEPLOY.local.md` if it exists (the maintainer's own server; untracked,
  like `deploy/push.sh`). The generic steps are in README.md.

Testing against the live app posts real messages: create your own discussion first and confirm it is the current one
(the current discussion is server-wide, shared by every browser window); turn the `memory` setting off during tests and
afterwards reset `memoryAt` (settings table) to the max message id, so test questions don't become "facts about the user".
Restart the server only when no agent is thinking (check `/events` state) — the user may be mid-discussion.

## Architecture

The server is split by what owns which state; imports only go downward (no cycles), lower modules never import
higher ones. Importing a module starts no timer and no server: `server.mjs` does that at startup.
- **app/workspace.mjs** — the filesystem: `DATA`/`WORK` paths, `RUNAS` (the agent OS user), each member's workspace,
  `inWork` (a path really under WORK, through symlinks), avatars, the shared git repo (`git`, `commitShared`).
- **app/db.mjs** — `data/chat.db`: schema, column migrations, indexes, `q`/`q1`/`run`, `getSetting`/`setSetting`.
- **app/config.mjs** — owns the members (`NAMES`, `memberConfigs`; seeded once per installed CLI, `saveMember`/
  `deleteMember`/`setAlias`) and the settings `S` (`saveSettings`); `tx`/`replyLang`, `atOf`/`aliasOf`/`handle`.
- **app/sse.mjs** — the browsers' connections: `send`, `sendViewers` (shared links), `sendState(Soon)`, `resync`
  (a full `init`). The snapshots are built in server.mjs and registered with `provide`.
- **app/chats.mjs** — owns discussions: the current one (`chatId`, `paused`/`circlePaused`, changed only via
  `setCurrent`/`setPaused`/`endCirclePause`), `chats.state` (`chatState`/`saveState`), mode and `rules`, names
  (`setNick`, `mentions`, `dmTo`), the message formats (`fmt`, `describe`), `insertMsg` (the only writer of messages,
  and the game-secrecy gate for what reaches the UI: `secret`/`visible`/`userPlays`), `note`, `logDecision`, and the
  archive (batched: `archiveSoon`; restart rewrites everything).
- **app/runtime.mjs** — owns the room's in-memory state: `rt` (each member's status, hand, live output, inbox `jobs`
  via `tell`), the reply queue `ready` and the `held` notes (both saved in settings `queue`, so a restart publishes
  replies already written: the member's session has moved past them), `pace` (reading/typing/read-aloud clocks),
  `raise`, `wrapRound`, and `pump` (the scheduler registers itself; other modules call it to say "look again").
- **app/schedule.mjs** — pure: `scoreHand`, `readMs`, `mayPublish` (unit-tested in schedule.test.mjs).
- **app/prompts.mjs** — a chat turn's prompt: `intro` (new session), `turnAsk` (per flow), `notesPrompt`.
- **app/flows.mjs** — who speaks next per flow: `wake` (a user message), relay, debate (`nextSlot`/`advanceDebate`),
  game (`gameNext`, `hostDone`, `gameOrder`, `userPlay`, `endGame`/`newGame`, `audit`). Raises hands and moves
  `chats.state` on; never starts a turn itself.
- **app/jobs.mjs** — [JOB] processes and [TASK] sessions: start, kill, end (`jobDone`: note, inbox, wake),
  `recoverJobs` at start, worktree cleanup, `jobReport` for the member's next turn.
- **app/outsider.mjs**, **app/arena.mjs** — the outsider and the training window (below).
- **app/room.mjs** — the scheduler and the turn lifecycle: `pump` (publish what is due, start the best eligible hands),
  `startTurn` (prompt → `runTurn` → parse → `addReady`), `publish`/`publishOne` (reading pace, markers, next hands),
  the moderator hooks (`assess`, `checkConvergence` — one judgment at a time, `checkShift`, `floorBack`), the Auto
  opening, memory curation, and the user's actions (`userSends`, `stopAll`, `switchTo`, `setChatMode`).
- **app/server.mjs** — HTTP only: input checks in the routes, which call the modules above (then `pump`), the `state`/
  `init` snapshots, static files, and startup (recover jobs, resume a game, timers). One "current chat" is global.
- **app/agents.mjs** — one adapter per CLI (`AGENTS[name].cmd` builds argv/env, `.parse` consumes one JSON event).
  `runTurn` spawns one headless process per turn, resuming the agent's own CLI session and pushing only unseen
  messages. Also `listModels` (each CLI's model list) and `runAs` (spawn as an unprivileged user).
- **app/modes.mjs** — the discussion modes as rules plus pure functions: each mode's flow (`free` raised hands,
  `relay` for stories, `debate` with drawn sides and an order of play), whether replies carry a [STANCE] line, whether
  the moderator steers, and what its notes are for; also the reply protocol (`parseReply`: [NOTE]/[STANCE]/[HAND]).
- **app/game.mjs** — game mode (pure): parsing the host's markers and ledger, the host's and players' briefs.
- **app/moderator.mjs** — Jev calls: `judge` (one request: convergence Score + stalling/debatable/challenged/circling
  Nouls) and `novelty` (one Noul per candidate: would it add something new?).
- **app/memory.mjs** — `curate`: a configured active member folds the user's new messages into `data/memory.md` (or NO_CHANGE).
- **app/index.html** + **app/ui.js** — the UI (no framework): markup and style in the page, logic in ui.js (served at
  `/ui.js`, syntax-checked in CI); renders SSE `init`/`state`/`msg` events, re-renders regions only when their HTML
  changes (`setHTML`) so the 1 s state tick doesn't swallow clicks.
- **app/i18n.mjs** — the UI in English: `EN` keyed by the Chinese text (`{x}` = a value filled in). UI and notes are
  written in Chinese and go through `tx(...)` (server: notes and errors; page: text built in JS, the static page once at
  load). Setting `uiLang` ('' = each browser's language) is served in `<html lang>`; notes are posted in it (or in the last
  browser's), stored notes stay as written. An empty `language` setting makes members reply in the UI's language.
  New UI text: write it in Chinese inside `tx()` and add the English to `EN`.

Turn flow: a user message raises every agent's "hand" → `pump()` (runs on every event and every second) starts the
best-scoring eligible hands up to `maxThinkers` → finished replies go to `ready` → `publish()` releases one at a time
after the previous message's reading time (`readMs`, counts CJK chars + Latin words, not `text.length`), holding while
the user types → publishing raises new hands ([HAND] marker, @mentions, broadcast mode) and triggers `assess()`
(Jev novelty, jev mode) and `checkConvergence()` (Jev judge → wrap-up summary, devil's advocate, or circling pause).

Modes (per discussion, Jev picks one for Auto, then the room waits `OPEN_HOLD` (10 s) so the user can switch it or start
at once; switching starts it in the new mode): research and roundtable use the free flow below; story is a relay
(one member at a time, the baton goes to whoever the passage @mentions, else the next member; skips members at the
turn cap); debate draws sides at its first message (odd member count: one member judges, even: the user does), plays
`debateScript` slot by slot (hands carry `slot`), and after the verdict continues as free discussion. Relay and debate
turns start only when nothing else is thinking or queued, so each sees the previous reply. Every discussion keeps
notes in `chats.state` (resources / setting / key lines): members change them with [NOTE add|edit|drop] lines, the
user in the UI, and every turn's prompt includes them (`notesPrompt`) so long discussions and stories don't drift.
Game (博弈; Auto picks it for a request to play, the room then asks for a host if none is @mentioned; state in `chats.state.game`): any game the user describes, hosted by the member the
first message @mentions (none: the server asks for one). The host (game.mjs hostBrief, flows.mjs hostDone) announces
rules, DMs private setups, keeps a private ledger ([STATE], stored in the game state, shown to the user) and picks each
next step ([PHASE talk n @b @a] / [PHASE orders @a @b] / [PAUSE] / [END]; no marker pauses too; listed handles set who speaks, in that order; unlisted: a random order per lap, turns still one after another); orders
reach it as `role='order'` DMs. The user can play too (setting `userPlays`, fixed at the game's start as `game.user`;
handle `@user`): `userPlay` takes its talk turn, its [DM @x] lines and its secret order (the next message in an orders
phase), and until the game is over the server sends the UI no DM or order between others, no ledger and no live output
(`visible`/`secret`), then everything (`send(init())`). The user can end a game (`/api/game/end`, a button in the moderator pane):
a host that never wrote [END] once kept the talk going for 17 rounds. After a game, "再开一局" (`/api/game/new`) keeps
the finished one in `chats.state.games` and the next message starts another in the same discussion, so everyone remembers
the earlier games. Games follow the current discussion only: switching back (or a restart) resumes a talk/orders phase. The host may run code (a rules program if it wants). A built-in commons game (fishing)
was removed: a member emptied the lake whenever it paid, so it taught nothing after the first game.
Private messages are `messages.dm` (the addressee): `TALK` excludes them (archive, Jev), `HEARS` shows them only to
sender and addressee; a DM runs over lines up to the next marker line (hosts DM whole tables); in a formal debate
teammates may DM each other. Players run code like in any turn (simulations,
strategy); `audit` flags tool calls touching other members' workspaces or CLI session files (🚨): all CLIs share one OS user, so this is
detection, not prevention.

Scheduling (free flow): score = relevance × fairness × freshness − cooldown (fairness modifies priority, it doesn't decide it);
modes `broadcast` / `algorithm` / `jev`. Every scheduler event is written to the `decisions` table for later A/B
analysis — keep logging new decision types there. Research mode opens a discussion with an independent round: until the first reply is published, every woken member
starts at once (ignoring `maxThinkers`), so nobody answers after reading another's answer (setting `blind`).
Every reply ends with `[STANCE n%] position`: `parseReply` moves it into `messages.stance`; members and Jev see it
(`withStance`), the UI shows a stance table, and Jev (`stanceShift`) judges whether a change was backed by a new argument.
Moderator notes are `kind='moderator'` messages: shown in the UI,
never sent to agents or Jev (`TALK` filter).

Outsider (setting `outsider`, research/roundtable): groups anchor, and so does Jev, which reads everything (in one discussion:
days stuck on a wall that each member's own model, asked cold, saw past in minutes). Every 40 members' messages, when
Jev sees circling (≥15 since the last), or on the user's button, one member (rotating: least outsider runs, then least
active lately) gets a fresh read-only session with only the user's messages and the shared files. Phase 1 thinks
without the archive; phase 2 (same session) reads the archive and keeps only untried ideas. The report is posted under
that member with `role='outsider'` (its own chat session sees it too, `UNSEEN`), and everyone answers it once, past the
turn cap and Jev's filter. Don't feed it the notes: they hold the group's conclusions.
Reply markers [HAND], [NOTE], [STANCE] count anywhere in a reply except inside backticks: agents put them mid-line,
several on one line, or before appended text (Claude's "Sources:"); line-anchored parsing leaked them into the chat.
[JOB], [TASK] and [FILE] act on files or start real work, so they only count at the start of their own line (mid-sentence mentions of [JOB]
were run as shell commands). If markers keep multiplying, the next step is our own MCP server (actions as tool calls).

Shared work (exec mode only): `WORK/_shared` is the members' git repo, its `public/` served at `/w/`; after every turn,
job and task the server commits what changed there as that member (`commitShared`, files over 500 KB skipped). Members
exist only during their turns (the prompt says so: they used to announce work "running in the background" that wasn't).
A turn's processes die with the CLI, so long work goes in a line of its own:
- `[JOB] <command>`: `startJob` runs it as the agent user in its own session, logging to `WORK/_jobs/J<id>.log`.
- `[TASK] <what to do>`: `startTask` runs the member's own harness and model as a fresh background session (60 min, no
  chat) in its workspace; `[TASK shared]` in a git worktree `WORK/_tasks/T<id>` on branch `task/T<id>`. At the end the
  worktree is committed and removed; a done task is merged (`--no-ff`) and its branch deleted, a conflict is aborted and
  the branch kept for the member. `cleanupTasks` (start + daily) prunes worktrees, deletes merged task branches and
  unmerged ones older than 7 days. One task per member (so as many as there are members).
Both post start/end notes and wake the member (hand `why: 'job'`, uncapped, past Jev's filter) with the result in its
next prompt (`jobReport`: log tail / task summary and merge outcome). Rows in the `jobs` table (`kind` job|task); a
restart marks running ones interrupted (worktree committed to its branch) and still tells and wakes the member. Jev
doesn't wrap up a round while one of the discussion's jobs or tasks runs.

Training window (exec only; the "训练窗口" panel): the user gives a goal, minutes and a referee
(`WORK/_shared/referees/<name>/referee.py`; `referees/kore/` in this repo is the reference). Every enabled file-capable
member gets a task session (startTask with `o.onEnd`: no chat notes, no wake-up) with the goal verbatim and no chat,
writing one entry `workspace/<member>/arena_<id>/bot.py`. The referee is copied to `WORK/_arena/<id>/referee` (root-owned,
so frozen); every `every` minutes the server probes changed entries with it and posts the win rate (system-measured);
at time-up or the user's button the sessions stop, `referee.py rank` gives the standings, and everyone is woken with
them (the meeting). Sessions that end early or die with a restart resume their CLI session (`onSid`) while ≥ 3 min are
left; three quick failures drop a member. State in `chats.state.arena`; `arena-*` decisions. Referee contract:
`probe <bot> <outdir>` / `rank <outdir> name=<bot> ...`, last stdout line JSON `{rate, games, replay?}` /
`{standings: [{name, rate, games}], replays?}`, replays written to outdir (served under `/w/arena/<id>/`).

Names ([NAME] 老狐狸, any mode): a member names itself for one discussion, in `chats.state.names` {member: [current,
...former]}, stored on each message (`messages.nick`, shown as a tag that @-mentions it). Names are only resolved by
`mentions` (@ and DM addressees): everything kept uses handles, so renames can't break state; former names keep working
and can't be taken; clashes (incl. prefixes) refused, at most 6 per member, refusals told in the next turn.

Members' files and avatars: a `[FILE] <path>` line attaches a file under WORK (resolved through symlinks: the server is
root) to the message, copied into `data/uploads/<chat>/` like the user's attachments (`attachFiles`, at most 4, 20 MB).
Each member's avatar is `avatar.png|jpg|webp|gif` in its workspace (`avatarOf`, served at `/avatar/<name>`, `members[].avatar`
= its mtime); `intro()` lists everyone's avatar path. Markdown images show inline only from this server (`/w/`, `/files/`,
`/avatar/`); other image URLs stay links.

Saved prompts (★ by the input): settings key `prompts`, [{id, title, text, mode}], sent with `init` only (never to a
shared link); using one fills the input (and sets its mode in an empty discussion, or in a new one via "新讨论").
The history list shows each discussion's id, the number the archive uses ("讨论 12").

Agents' context: a new CLI session gets `intro()` (rules, members, archive location, the user memory) plus recent
history; resumed sessions get only unseen messages plus a per-turn footer. Discussions are archived as
`data/discussions/<id>.md` + `index.md` so agents can look up earlier ones.
Every turn's roster uses currently enabled members, their aliases, harnesses and configured model IDs.
Never infer membership from adapter names or assume a fixed participant count/model. Empty model IDs use CLI defaults.
Memory curation uses the first enabled idle member in display order, with its configured model and credentials.
The moderator model is supplied by TYPESAFE_MODEL in the service environment.

## CLI adapter rules (learned the hard way)

- Run agents "plain": Claude with `--setting-sources project --disable-slash-commands --strict-mcp-config` and a
  `--tools`/`--allowedTools` list (user plugins like Ponytail made replies terse; `-p` silently refuses tools that need
  approval, incl. WebSearch); Codex with `--ignore-user-config`; OpenCode with every user MCP server disabled via
  `OPENCODE_CONFIG_CONTENT`. Strip `ANTHROPIC_*`/`CLAUDE_CODE_*` env vars for Claude (the desktop app's override login).
- Never trust exit codes; classify output (quota/auth/denied actions). Headless agy ends a turn with an EMPTY reply when
  any action is denied — report `denied_actions`, and keep prompts telling agy not to run shell commands in read-only mode.
- Codex reads files only via shell: in read-only mode it may use read-only commands; pass model and sandbox on every
  `exec resume` (resume ignores the original settings). Windows: use the Codex app's bundled `codex.exe`.
- OpenCode 1.x vs 2.x differ (`--pure` vs `--standalone`, no `step_finish` in 2.x, version detected once). Bun-based
  CLIs lose stdout written to a Node pipe on exit: one-shot commands capture stdout to a temp file (`out()`), and
  OpenCode turns write to a temp file the server tails (`toFile`; a whole finished reply was lost once).
- Set `PWD` to the turn's cwd (opencode 2 and agy take the project directory from it).
- Cross-platform: Windows uses PATH lookup with `.exe`/`.cmd` and `taskkill`; Linux spawns detached and kills the process
  group. `.gitattributes` forces LF (CRLF broke the systemd unit).

## Server deployment

`AGENT_USER=agent` (in `/etc/agent-chat.env`, with `TYPESAFE_API_KEY`) makes the root service spawn every CLI as the
unprivileged `agent` user, each in `workspace/<member>`; `chat.db` is mode 600, the archive and memory are readable.
Only then does the `exec` setting take effect (Claude Bash/Edit/Write, Codex `danger-full-access`, agy without
plan mode, OpenCode build agent `--auto`). The CLI logins live in `/home/agent` (copied from root by
`deploy/setup-agent-user.sh`); use `su - agent` to run them by hand. The app has no login: LAN only.

One instance per person (systemd template `agent-chat@<name>`, settings in `/etc/agent-chat-<name>.env`): the first
with the default `data/` and `workspace/`, the others with their own `PORT`, `DATA_DIR` and `WORK_DIR`, so
discussions, memory and workspaces never mix (all run as `agent`: separated by paths, not permissions). `/who` is the
entry page (`PROFILES` in `/etc/agent-chat.env`). agy needs each WORK_DIR in its trustedWorkspaces.
