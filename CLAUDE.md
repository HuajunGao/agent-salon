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
- Syntax check: `node --check app/server.mjs` (and the other `.mjs` files)
- Tests (real server + SQLite, fake harness, no paid calls): `node --test app/members.test.mjs app/modes.test.mjs app/speech.test.mjs app/stance.test.mjs app/env.test.mjs app/flows.test.mjs`.
  Verify adapters by importing them directly, e.g.
  `node -e 'import("./app/agents.mjs").then(async m => console.log(await m.runTurn("codex", "1+1?", null, {cwd: "workspace", dataDir: "data", onLive(){}})))'`
  (a second call with the returned `sid` checks session resume). `moderator.mjs` `judge`/`novelty` and `memory.mjs`
  `curate` can be exercised the same way; Jev needs `TYPESAFE_API_KEY`.
- Deploy committed HEAD to the home server (Proxmox LXC, root@server.lan) and restart: `bash deploy/push.sh`
- Server logs: `ssh root@server.lan journalctl -u agent-chat@alice -f` (or `@bob`)

Testing against the live app posts real messages: create your own discussion first and confirm it is the current one
(the current discussion is server-wide, shared by every browser window); turn the `memory` setting off during tests and
afterwards reset `memoryAt` (settings table) to the max message id, so test questions don't become "facts about the user".
Restart the server only when no agent is thinking (check `/events` state) — the user may be mid-discussion.

## Architecture

- **app/server.mjs** — everything stateful: SQLite (`data/chat.db`: chats, messages, agent_sessions with each agent's
  CLI session id, decisions log, settings), SSE to the UI, the scheduler, the reading-pace publish queue, the moderator
  hooks, memory curation and the HTTP API. Members and their configurations live in the members table.
  One "current chat" is global to the server.
- **app/agents.mjs** — one adapter per CLI (`AGENTS[name].cmd` builds argv/env, `.parse` consumes one JSON event).
  `runTurn` spawns one headless process per turn, resuming the agent's own CLI session and pushing only unseen
  messages. Also `listModels` (each CLI's model list) and `runAs` (spawn as an unprivileged user).
- **app/modes.mjs** — the discussion modes as rules plus pure functions: each mode's flow (`free` raised hands,
  `relay` for stories, `debate` with drawn sides and an order of play), whether replies carry a [STANCE] line, whether
  the moderator steers, and what its notes are for; also the reply protocol (`parseReply`: [NOTE]/[STANCE]/[HAND]).
- **app/game.mjs** — game mode's host program (pure): the commons engine (setup/rules/view/act/resolve/final) and
  each turn's brief. A program, not a model, keeps the state and resolves rounds.
- **app/moderator.mjs** — Jev calls: `judge` (one request: convergence Score + stalling/debatable/challenged/circling
  Nouls) and `novelty` (one Noul per candidate: would it add something new?).
- **app/memory.mjs** — `curate`: a configured active member folds the user's new messages into `data/memory.md` (or NO_CHANGE).
- **app/index.html** — the whole UI (no framework); renders SSE `init`/`state`/`msg` events, re-renders regions only
  when their HTML changes (`setHTML`) so the 1 s state tick doesn't swallow clicks.

Turn flow: a user message raises every agent's "hand" → `pump()` (runs on every event and every second) starts the
best-scoring eligible hands up to `maxThinkers` → finished replies go to `ready` → `publish()` releases one at a time
after the previous message's reading time (`readMs`, counts CJK chars + Latin words, not `text.length`), holding while
the user types → publishing raises new hands ([HAND] marker, @mentions, broadcast mode) and triggers `assess()`
(Jev novelty, jev mode) and `checkConvergence()` (Jev judge → wrap-up summary, devil's advocate, or circling pause).

Modes (per discussion, Jev picks one for Auto): research and roundtable use the free flow below; story is a relay
(one member at a time, the baton goes to whoever the passage @mentions, else the next member; skips members at the
turn cap); debate draws sides at its first message (odd member count: one member judges, even: the user does), plays
`debateScript` slot by slot (hands carry `slot`), and after the verdict continues as free discussion. Relay and debate
turns start only when nothing else is thinking or queued, so each sees the previous reply. Every discussion keeps
notes in `chats.state` (resources / setting / key lines): members change them with [NOTE add|edit|drop] lines, the
user in the UI, and every turn's prompt includes them (`notesPrompt`) so long discussions and stories don't drift.
Game (博弈, never picked by Auto): the first message starts the commons with the enabled members ("4 轮" sets rounds;
hard by default: random regrowth, only the lake size public, a random end; "经典" for the classic rules);
state in `chats.state.game`. Each round the players talk in turn (twice each) in public or with `[DM @x]` lines, then
all give `[ACT] n` at once in turns that are never posted (the user sees them as 🔒 notes), then the server resolves.
Private messages are `messages.dm` (the addressee): `TALK` excludes them (archive, Jev), `HEARS` shows them only to
sender and addressee; in a formal debate teammates may DM each other. The members learn the public totals and their own catches from the brief, not from notes.
Free game: "@x 主持，玩…" makes member x the host (game.mjs hostBrief, server hostDone): it announces rules, DMs private
setups, keeps a private ledger ([STATE], stored in the game state, shown to the user) and picks each next step
([PHASE talk n] / [PHASE orders @a @b] / [END]); orders reach it as `role='order'` DMs. The host may run code (a rules
program if it wants); players' game turns are read-only, and `audit` flags tool calls touching other members'
workspaces or CLI session files (🚨): all CLIs share one OS user, so this is detection, not prevention.

Scheduling (free flow): score = relevance × fairness × freshness − cooldown (fairness modifies priority, it doesn't decide it);
modes `broadcast` / `algorithm` / `jev`. Every scheduler event is written to the `decisions` table for later A/B
analysis — keep logging new decision types there. Research mode opens a discussion with an independent round: until the first reply is published, every woken member
starts at once (ignoring `maxThinkers`), so nobody answers after reading another's answer (setting `blind`).
Every reply ends with `[STANCE n%] position`: `parseReply` moves it into `messages.stance`; members and Jev see it
(`withStance`), the UI shows a stance table, and Jev (`stanceShift`) judges whether a change was backed by a new argument.
Moderator notes are `kind='moderator'` messages: shown in the UI,
never sent to agents or Jev (`TALK` filter).

Outsider (setting `outsider`, research/roundtable): groups anchor, and so does Jev, which reads everything (discussion 28:
days stuck on a wall that each member's own model, asked cold, saw past in minutes). Every 40 members' messages, when
Jev sees circling (≥15 since the last), or on the user's button, one member (rotating: least outsider runs, then least
active lately) gets a fresh read-only session with only the user's messages and the shared files. Phase 1 thinks
without the archive; phase 2 (same session) reads the archive and keeps only untried ideas. The report is posted under
that member with `role='outsider'` (its own chat session sees it too, `UNSEEN`), and everyone answers it once, past the
turn cap and Jev's filter. Don't feed it the notes: they hold the group's conclusions.
Reply markers [HAND], [NOTE], [STANCE] count anywhere in a reply except inside backticks: agents put them mid-line,
several on one line, or before appended text (Claude's "Sources:"); line-anchored parsing leaked them into the chat.
[JOB] and [TASK] start real work, so they only count at the start of their own line (mid-sentence mentions of [JOB]
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
  CLIs lose stdout written to a Node pipe on exit: one-shot commands capture stdout to a temp file (`out()`).
- Set `PWD` to the turn's cwd (opencode 2 and agy take the project directory from it).
- Cross-platform: Windows uses PATH lookup with `.exe`/`.cmd` and `taskkill`; Linux spawns detached and kills the process
  group. `.gitattributes` forces LF (CRLF broke the systemd unit).

## Home server

`AGENT_USER=agent` (in `/etc/agent-chat.env`, with `TYPESAFE_API_KEY`) makes the root service spawn every CLI as the
unprivileged `agent` user, each in `workspace/<member>`; `chat.db` is mode 600, the archive and memory are readable.
Only then does the `exec` setting take effect (Claude Bash/Edit/Write, Codex `danger-full-access`, agy without
plan mode, OpenCode build agent `--auto`). The CLI logins live in `/home/agent` (copied from root by
`deploy/setup-agent-user.sh`); use `su - agent` to run them by hand. The app has no login: LAN only.

One instance per person (systemd template `agent-chat@<name>`, settings in `/etc/agent-chat-<name>.env`): alice on
3517 with the default `data/` and `workspace/`, bob on 3518 with `DATA_DIR=data-bob`, `WORK_DIR=workspace-bob`, so
discussions, memory and workspaces never mix (both run as `agent`: separated by paths, not permissions). `/who` is the
entry page (`PROFILES` in `/etc/agent-chat.env`). agy needs each WORK_DIR in its trustedWorkspaces.
