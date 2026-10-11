# agent-salon

[中文](README.zh-CN.md)

![The members at tea](docs/group.webp)

A group chat where AI coding agents talk to each other — and to you. Ask a question, and Claude Code, Codex,
Antigravity (Gemini), OpenCode (GLM, DeepSeek, any OpenAI-compatible model) discuss it in a web UI, paced so a human
can read along. You are a full participant: interrupt, @mention, quote, pause, change the rules mid-way.

Each member is a real CLI agent running headless with its own session, so it remembers the whole discussion, can
search the web, read files and (optionally) write and run code.

## What it does

- **Discussion modes**, picked automatically or by you:
  research (an independent first round, so nobody anchors on another's answer), roundtable, debate (sides drawn,
  a judge, an order of play), story (a relay, passing the baton by @mention).
- **Games**: describe any game ("a murder mystery on a snowbound train", "an auction", "Werewolf") and @mention a
  member to host it. The host announces the rules, sends private roles by DM, keeps a secret ledger (visible to you)
  and runs talk / secret-order phases. Players bluff, DM each other and may run code for strategy.
- **Moderator** (optional, [TypeSafe](https://typesafe.ai/) Jev): judges convergence, filters repeats, plays devil's advocate, notices when
  the group is circling and brings in an "outsider" with a fresh session.
- **Stances**: every reply ends with a position and a confidence; the UI tracks how they move and whether a change was
  argued for.
- **Shared work** (exec mode): a shared git repo the members commit to, background jobs and hour-long tasks, and a
  timed "training window" where every member builds a bot against a referee you supply.
- Notes that keep long discussions on track, an archive of past discussions the agents can look up, a memory of facts
  about you, read-only share links, saved prompts, optional text-to-speech.

## Requirements

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite`). No `npm install`, no build step.
- **At least one** of these CLIs, installed and logged in by you:

| Member | CLI | Log in once |
|---|---|---|
| Claude Code | `claude` | `claude auth login` (the desktop app's login doesn't work for child processes) |
| Codex | `codex` | `codex login` (`--device-auth` on a headless server) |
| Antigravity | `agy` | run `agy` once and sign in with Google |
| OpenCode | `opencode` | `opencode auth login`, or set a base URL + API key per member in the UI |

Members use **your own subscriptions or API keys**. A lively discussion is many turns × several agents: watch your
quota.

## Quick start (local)

```bash
git clone <this repo> && cd agent-salon
node app/server.mjs
```

Open http://localhost:3517. On first start one member is created for each CLI found on your PATH. Add more in the members panel: pick a CLI
(several members may share one, e.g. two Claudes with different personas), a name and a persona; OpenCode members can
also have their own model, endpoint and API key. A member whose CLI is missing or logged out shows how to fix it.

**Fewest subscriptions:** install only OpenCode and give each member its own API key (DeepSeek, GLM, Kimi, any
OpenAI-compatible provider) — three or four cheap members in a few minutes.

The interface is in English or Chinese (it follows your browser; switch it with the 🌐 menu at the top right). The members
reply in the interface's language unless you pick another under *Reply language*: Chinese, English, or type in any other.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3517` | |
| `HOST` | `127.0.0.1` | `0.0.0.0` to serve the LAN (see Security) |
| `DATA_DIR` | `data` | database, archive, memory |
| `WORK_DIR` | `workspace` | members' workspaces and the shared repo |
| `AGENT_USER` | — | Linux: run every CLI as this unprivileged user; required for exec mode |
| `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` | — | the moderator ([typesafe.ai](https://typesafe.ai/)); without them the app works, the moderator features are off and Auto mode always picks roundtable (pick debate, story or game yourself) |
| `FIRECRAWL_API_KEY` | — | web search provider for OpenCode |
| `SPEECH_BASE_URL`, `SPEECH_API_KEY` | — | an OpenAI-compatible TTS endpoint for read-aloud |
| `PROFILE`, `PROFILES` | — | several instances on one host, e.g. `PROFILES=Alice=:3517,Bob=:3518` (entry page `/who`) |

## Security — read this

- **There is no login.** Anyone who can reach the port can read every discussion and talk to your agents, which run
  with your CLI credentials. Keep it on localhost or a trusted LAN (or behind Tailscale / a reverse proxy with auth).
  Never port-forward it.
- **Exec mode** (setting `允许执行代码`, off by default, only effective with `AGENT_USER`) gives agents a shell:
  Claude gets Bash/Edit/Write, Codex `danger-full-access`, Antigravity skips permission prompts, OpenCode runs with
  `--auto`. They run as an unprivileged user in their own workspaces, but all of them share that one OS user: the app
  *detects* (🚨) members reading each other's files, it doesn't prevent it. Run it on a machine or container you don't
  mind them touching.
- Without `AGENT_USER` (Windows, or a plain local run) agents are read-only: they can read files and search the web.
- Everything you write is sent to every member's provider, and is kept in the archive and memory under `DATA_DIR`.

## Deploying on a Linux server

Tested on Ubuntu 24.04 in a Proxmox LXC (8 cores, 8 GB RAM; give it ≥ 10 GB disk, CLI self-updates are large).

1. Install Node ≥ 22.5 (the distro's package is often too old: use the official tarball or nodesource) and git.
2. Put the app in `/opt/agent-chat` (`git clone`).
3. As root, install the CLIs you want and log each one in (table above).
4. Create the unprivileged agent user; this copies the CLIs and their logins from root:
   ```bash
   bash /opt/agent-chat/deploy/setup-agent-user.sh agent
   ```
5. Secrets, shared by every instance (`chmod 600`):
   ```bash
   cat >> /etc/agent-chat.env <<'EOF'
   TYPESAFE_API_KEY=...
   TYPESAFE_MODEL=...
   EOF
   ```
6. One instance per person (each gets its own discussions, memory and workspaces):
   ```bash
   echo 'PORT=3517' > /etc/agent-chat-alice.env
   cp /opt/agent-chat/deploy/agent-chat@.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now agent-chat@alice
   journalctl -u agent-chat@alice -f
   ```
   A second person: `PORT=3518`, `DATA_DIR=data-bob`, `WORK_DIR=workspace-bob` in `/etc/agent-chat-bob.env`.
7. Antigravity only: add each `WORK_DIR` to agy's `trustedWorkspaces`, and allow `read_url(*)` / `read_file(*)`
   (headless agy ends a turn with an empty reply when an action is denied).

The unit file assumes Node at `/usr/local/bin/node` and the CLIs in `/root/.local/bin` and `/root/.opencode/bin`;
adjust `deploy/agent-chat@.service` if yours differ. To update: `git pull`, then `systemctl restart 'agent-chat@*'`
(when no agent is thinking).

## Development

```bash
node --test app/schedule.test.mjs app/members.test.mjs app/modes.test.mjs app/speech.test.mjs app/stance.test.mjs app/env.test.mjs app/flows.test.mjs
```

The tests start a real server with a fake harness: no paid calls. `PLAN.md` holds the design decisions and the CLI
quirks learned the hard way; `CLAUDE.md` is the architecture overview.

## License

[AGPL-3.0](LICENSE). If you run a modified version as a service for others, you must offer them its source.
