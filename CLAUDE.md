# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A local "agent group chat": the user asks a question and configurable members, each using a CLI harness and model,
discuss it in a web UI, paced for human reading, with TypeSafe as a moderator. PLAN.md holds the
design decisions, the hard-won CLI details and the home-server deployment notes; read the relevant section before
changing scheduling, adapters or deployment. The user communicates in Chinese; UI text and agent prompts' output
language follow the `language` setting (default 中文).

## Commands

No npm dependencies, no build step. Node ≥ 22.5 (uses built-in `node:sqlite`).

- Run locally: `node app/server.mjs` → http://localhost:3517 (`PORT`, `HOST` env; `.claude/launch.json` has a preview config)
- Syntax check: `node --check app/server.mjs` (and the other `.mjs` files)
- Tests (real server + SQLite, fake harness, no paid calls): `node --test app/members.test.mjs app/modes.test.mjs`.
  Verify adapters by importing them directly, e.g.
  `node -e 'import("./app/agents.mjs").then(async m => console.log(await m.runTurn("codex", "1+1?", null, {cwd: "workspace", dataDir: "data", onLive(){}})))'`
  (a second call with the returned `sid` checks session resume). `moderator.mjs` `judge`/`novelty` and `memory.mjs`
  `curate` can be exercised the same way; Jev needs `TYPESAFE_API_KEY`.
- Deploy committed HEAD to the home server (Proxmox LXC, root@server.lan) and restart: `bash deploy/push.sh`
- Server logs: `ssh root@server.lan journalctl -u agent-chat -f`

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

Scheduling: score = relevance × fairness × freshness − cooldown (fairness modifies priority, it doesn't decide it);
modes `broadcast` / `algorithm` / `jev`. Every scheduler event is written to the `decisions` table for later A/B
analysis — keep logging new decision types there. Moderator notes are `kind='moderator'` messages: shown in the UI,
never sent to agents or Jev (`TALK` filter).

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
Only then does the `exec` setting take effect (Claude Bash/Edit/Write, Codex `workspace-write` + network, agy without
plan mode, OpenCode build agent `--auto`). The CLI logins live in `/home/agent` (copied from root by
`deploy/setup-agent-user.sh`); use `su - agent` to run them by hand. The app has no login: LAN only.
