# Security

## The model

agent-salon has **no login**: anyone who can reach its port can read every discussion and drive your agents, which run
with your CLI credentials. It is meant for localhost, a trusted LAN, or behind a VPN / a reverse proxy with
authentication. In exec mode the agents get a shell as an unprivileged user (`AGENT_USER`) that they all share. See
[README → Security](README.md#security--read-this) for the details.

So "someone on the network can use the app" is the documented model, not a vulnerability. These are:

- reading or writing files outside what the app means to expose (`/files/`, `/w/`, `/avatar/`), e.g. path traversal
  or a symlink trick that makes the server (often root) serve or copy a file it shouldn't;
- an agent escaping `AGENT_USER` (reaching the database, the env file, the server's own files);
- script running in the app's origin from a message, an attachment, a shared link (`/s/<code>`) or a member's page;
- a shared link revealing more than its one discussion;
- credentials (API keys, CLI logins) leaking into the UI, the archive, logs or prompts.

## Reporting

Please report privately: **Security → Report a vulnerability** on this repository (GitHub private vulnerability
reporting), not a public issue. Include the version (commit), the setup (OS, `AGENT_USER`, exec on/off) and the steps.
This is a one-person project: expect an answer within a week or two.
