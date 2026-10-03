# agent-chat — plan

A local group chat where the user asks a question and several coding-agent CLIs on this machine
(Claude, Codex, Gemini, GLM) discuss it freely, with a small web UI that shows the live conversation.
A cheap judgment model (TypeSafe Jev) acts as moderator. Slow models must still get a say.

## Prior art (checked 2026-10-03)

- [soft-jp-com/ai-agent-room](https://github.com/soft-jp-com/ai-agent-room) (Go, Apache-2.0): closest. Headless CLI per
  turn; "free talk" mode = one loop per agent that launches the CLI on every new message and asks whether it wants to
  speak; fast agents speak first; per-agent live output; limits; session rotation; "summarize & new chat". Supports only
  claude / codex / agy; system prompts in Japanese; waking every agent on every message burns quota; no moderator.
- [bcurts/agentchattr](https://github.com/bcurts/agentchattr) (MIT): interactive terminals + MCP `chat_read`/`chat_send`;
  @mention injects keystrokes into the agent's terminal. Rich (channels, jobs, roles, rules, session templates, loop
  guard) but fragile on Windows and @-driven rather than free discussion.
- Why build our own: support all four of the user's agents, a moderator that decides who to wake (saves quota), and
  explicit fairness for slow agents.

## Design

### Storage: SQLite (`data/chat.db`)
Use Node's built-in `node:sqlite` (`DatabaseSync`, works on this machine's Node v25.9; no npm dependency).
The server is the only writer. Tables (sketch):
- `messages(id INTEGER PRIMARY KEY, chat_id, sender, kind, text, based_on, latency_ms, created_at)`:
  the single source of truth. `kind` = user | agent | moderator | system. `based_on` = last message id the agent
  had seen when it started thinking.
- `agent_sessions(chat_id, agent, cli_session_id, last_seen_id, turns, status, updated_at)`: **record every agent's
  CLI session id** (needed to resume) and how far it has read.
- `chats(id, title, created_at, paused)`: separate discussions; switching chats restores each agent's session.
- `data/transcript.md`: human-readable export kept current; agents may read it to look further back.
- Agent CLI sessions live in each CLI's own store (~/.claude, ~/.codex, OpenCode db, agy). Don't relocate them
  (credentials live there too). They are a cache: if resume fails or a session gets too long, start a new session
  seeded with a summary + the last N messages from `messages`.

### Agent turns (push deltas)
- Every turn is a fresh headless CLI process resuming the agent's session. The server sends only what the agent
  hasn't seen: "New messages since your last turn: #13 …, #14 … Reply, or answer exactly PASS if you have nothing new."
- All agents run with cwd = `workspace/` and are told the discussion is read-only (no file edits).
- An agent that is thinking is never cancelled by new messages; its reply is always delivered.

### Fairness for slow agents
- Reply shows "↪ #N (+k newer messages)" when other messages arrived while it was thinking.
- Late reply check (moderator): if it adds nothing beyond what was said since `based_on`, show it collapsed; if it
  is useful but missed the latest turn, give it one short "delta" turn to update.
- Before wrapping up a discussion, wait for agents still thinking (with a timeout).
- UI shows "✋ thinking 45s" per agent so everyone sees who is preparing to speak.

### Floor control: pause, equal turns, raising hands
- **Pause / resume** from the UI at any time: pausing stops new turns from starting; turns already running finish
  and their replies are kept. Resume continues from the queue. Stop = pause + cancel queued turns.
- **Raising a hand** is a cheap signal, not a CLI call (launching a CLI just to ask "do you want to speak?" is what
  makes ai-agent-room expensive). Sources of a raised hand:
  - the moderator's per-agent judgment "would <agent> add something new here?" (one Noul per agent, all in the same
    Jev request);
  - an agent ending its reply with a hand-raise marker (e.g. `[HAND]`) to ask for a follow-up turn;
  - an agent still thinking counts as a raised hand (it will speak).
  The UI shows hands (✋) and the queue.
- **Opportunity fairness, not equal message count** (user, 2026-10-03): fairness modifies priority, it doesn't
  decide it. Among raised hands, score = relevance/novelty × fairness multiplier (grows, capped, with silence) ×
  freshness (hand decays over minutes) − dominance/cooldown penalty (just spoke; turns since the user's message).
  Hands scoring ≤ 0 are dropped. Relevance comes from explicit signals in Phase 1 (user floor > user @mention >
  reply-to target > agent @mention > [HAND] > plain wake) and from Jev in Phase 2. Hard cap of turns per agent per
  user message (configurable in the UI). Slow agents keep their place in the queue while thinking.
- **Scheduler modes** (UI setting, for A/B): `broadcast` (every published message wakes all agents, FIFO),
  `algorithm` (score above), `jev` (Jev-assisted; falls back to algorithm until Phase 2).
- **Decision log from day one**: table `decisions` records every scheduler event (user, start with all candidates'
  scores, skip, ready, pass, error, resume-failed, publish, floor, stop) with mode, based_on, latency, stale,
  turn number; `messages` also stores reply_to, turn_no, stale, collapsed.
- The user can always @mention an agent (jumps the queue) or click an agent to give it the floor.

### Pacing: readable by a human
The conversation must move at the user's reading speed, not as fast as agents can type.
- **Separate thinking from publishing.** Agents may think ahead, but finished replies wait in a publish queue and
  are released one at a time.
- **Reading time.** After each message is shown, wait ~ its length ÷ the user's reading speed (setting; e.g. 400
  Chinese chars/min) before releasing the next. A "read it, next" button skips the wait; typing in the input box
  holds the queue until the user sends or clears it.
- **Think during reading.** Start the next speaker's turn while the user reads the current message, so slow agents'
  latency is hidden by reading time.
- **Limit concurrent thinkers** (setting, default 2) so replies don't all answer an outdated state.
- UI shows the publish queue ("✍️ GLM ready, #2 in line").
- At reading pace there are only a few dozen messages per hour, so quota is not a concern; the turn cap is a guard
  against runaway loops, not a budget.

### The user is a participant
- The user can post at any time: opinions, objections, new facts. User messages skip the publish queue and are
  pushed to every agent on its next turn, which is told to engage with the user's points.
- The user can @mention an agent, quote/reply to a specific message ("I disagree with #14"), or click an agent to
  give it the floor.
- Queued replies written before a user message are marked as such; the moderator decides whether they are still
  relevant (stale ones are collapsed).

### Moderator (TypeSafe Jev)
- **Implemented: convergence wrap-up** (app/moderator.mjs). After each published agent message, once everyone woken
  this round has weighed in (nobody without a message this round is still thinking, queued or holding a hand), one
  request asks a Score "how converged are the views" (4 levels; "same main answer, stated independently or by
  agreeing" counts as fully converged) and a Noul "do recent messages only agree/restate". Stop when convergence ≥
  threshold (UI, default 80%) or (≥ 67% and restating ≥ 0.6): hands are cleared, a 🧭 note is posted, and after
  slow agents still thinking have published, the member most engaged this round writes a summary. A new user
  message starts a new round. Measured: ~230–320 ms per request, ~1.1–1.6k input tokens.
  On the first three test chats it separated "still arguing" (14–74%) from "everyone gave the same answer" (97–100%).
- **Implemented: Jev scheduler** (`jev` mode). After each published message, one request asks a Noul per idle
  candidate (enabled, under the cap, has unseen messages): "would @x add something new if it spoke next?". Novelty
  becomes the relevance term (relevance = signal × 2 × novelty; 0.5 = neutral) in score × fairness × freshness −
  cooldown. Candidates at or above the novelty threshold (UI, default 45%) are invited; follow-up hands below it
  are dropped without launching a CLI. The user's own wake-ups, @mentions and floor are never second-guessed; a
  user message still wakes everyone. On a Jev error it falls back to the algorithm for one minute.
- **Moderator presence**: moderator notes are their own message kind (shown as 🧭 pills, never fed to agents or
  Jev): invitations with novelty, the convergence wrap-up, and "nobody has anything new: your turn" when the room
  goes quiet without converging. A moderator card shows its status, the convergence and restating meters with
  the threshold, and per-member novelty bars.
- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, model `jev-latest`; body
  `{state, model, questions}`; answers carry probabilities/confidence. The key is in a `TYPESAFE*` env var
  (keep server-side). Read https://docs.typesafe.ai/llms.txt and the API/primitive pages before coding.
  Latency and price aren't published: measure.
- On each new message, ask in one request (parallel questions over the same state):
  - Choice: who should speak next (each agent, or "nobody, wait for the user") → only wake that agent.
  - Noul: has the discussion converged? → one agent writes a summary, then stop.
  - Noul: is it going in circles / repeating? → pause and ask the user.
  - Score: how much disagreement is there? → if very low, invite one agent to argue the other side.
  - (on a late reply) Noul: does it add something new? → normal / collapsed / delta turn.
- Show every moderator decision in the chat ("🧭 invite GLM (0.71)"). A human @mention always overrides.

### Web UI
- **Implemented layout**: left = discussion history (newest activity first, latest question as preview, message
  count, auto-title from the first question, full-text search over titles and messages with jump-to-message,
  rename, Markdown export, delete with confirmation); middle = chat; right = moderator card, members (harness +
  model picker), settings.
- Single `index.html` (no framework) + SSE from the server. Left: members with status (idle / ✋ thinking Ns /
  paused), per-agent live CLI output (expandable), usage vs limit. Right: messages with sender, latency, "↪ #N",
  moderator notes. Input with @mentions; Pause, Summarize, Stop.

### Layout
```
app/        server.mjs, agents.mjs (CLI adapters), moderator.mjs, index.html
data/       chat.db, transcript.md   (gitignored)
workspace/  agents' cwd
```
Node.js, no frameworks, no npm dependencies (built-in `node:sqlite`, `node:http`, SSE).

## Agent adapters (hard-won details; see ~/.claude/skills/delegate-agents/run-agent.sh)

| agent | new turn | resume | notes |
|---|---|---|---|
| claude | `claude -p "<msg>" --output-format json` | `--resume <id>` | Plain `claude` is Anthropic Claude (GLM config moved to ~/.claude/settings-glm.json). If launched from inside the Claude desktop app, unset ANTHROPIC_*/CLAUDE_CODE_* env vars first. Consider `--settings '{"disableAllHooks":true}'` and disabling plugins (Ponytail's SessionStart hook injects a "write less" persona). |
| codex | `codex exec --skip-git-repo-check -m gpt-6.1-sol -c sandbox_mode=read-only "<msg>"` | `codex exec resume <id> …` (pass -m and sandbox again: resume ignores the original settings) | Use the app's bundled CLI: newest `~/AppData/Local/OpenAI/Codex/bin/*/codex.exe` (the one on PATH is older and rejects new models). Session id: `session id:` line. Quota errors: "hit your usage limit". |
| gemini | `agy -p "<msg>" --model gemini-3.8-flash-medium --output-format json` | `--conversation <id>` | JSON output only at the end. Id: `"conversation_id"`. |
| glm | `opencode run --pure -m zai-coding-plan/glm-5.3 --format json "<msg>"` | `-s <ses_id>` | `--pure` required (oh-my-openagent plugin kills work). Set `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=131072` (32k default truncates GLM thinking; exits 0 anyway). GLM 5.3 is text-only; glm-5.3-flash is multimodal. Alternative harness: `claude-glm` (~/.local/bin). |

General: never trust exit codes (check `"reason":"length"`, quota/auth errors); add a no-output timeout (a hung
request once sat for an hour); keep logs outside anything an agent might clean up.

## Run

`node app/server.mjs`, then open http://localhost:3517 (set PORT to change it). The standalone `claude` CLI must be
logged in once (`claude auth login`); the desktop app's own login isn't usable by child processes.

## Phases

1. **MVP**: server + SQLite + SSE + UI; four adapters with resume and delta push; a user message wakes all agents
   in parallel; replies with "↪ #N"; thinking status + live output; pause / resume; per-agent turn cap; turn
   queue preferring the fewest turns; `[HAND]` marker hand-raising; reading-pace publish queue with "next" button
   and hold-while-typing; user messages, @mentions and quote-replies; live settings (language, turn cap, reading
   speed, concurrent thinkers).
2. **Moderator**: Jev integration as above; measure its latency; show decisions in the UI.
3. **Polish**: roles/personas, export minutes, session rotation with summaries, per-agent latency/usage stats.

## Decisions (user, 2026-10-03)
- **Build our own** in Node (borrow ideas from ai-agent-room / agentchattr; don't fork: Go + Japanese prompts +
  no OpenCode + no moderator would mean rewriting most of it anyway).
- Members: **claude, codex, antigravity (agy), opencode (GLM 5.3)**. GLM goes through **OpenCode**.
- Storage: **SQLite** (`node:sqlite`), recording each agent's CLI session id.
- UI must allow pause / resume at any time, roughly equal speaking time, and hand-raising (see Floor control).
- Settings live in the UI and take effect immediately: discussion language (default Chinese), per-agent turn cap
  (adjustable live; a lowered cap removes agents from the queue, a raised one lets them raise hands again),
  reading speed, max concurrent thinkers.
- The conversation is paced for human reading (see Pacing); the user is a full participant (see The user is a
  participant).
