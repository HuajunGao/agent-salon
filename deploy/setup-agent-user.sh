#!/usr/bin/env bash
# One-time (re-runnable) server setup: the unprivileged user the agent CLIs run as.
#   bash /opt/agent-chat/deploy/setup-agent-user.sh [user]      (as root, on the server; default user: agent)
# The CLIs were installed and logged in as root; their programs and logins are copied to the user (root keeps its
# copy). Afterwards the service runs every CLI as this user: it can write and execute only in its own home and in
# /opt/agent-chat/workspace/<member>; the database, /root and /etc/agent-chat.env stay out of reach.
set -euo pipefail
U=${1:-agent}
id "$U" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$U"
HOMEU=$(getent passwd "$U" | cut -d: -f6)

for d in .claude .claude.json .codex .gemini .local .opencode .config/opencode; do
  [ -e "/root/$d" ] || continue
  mkdir -p "$HOMEU/$(dirname "$d")"
  rm -rf "${HOMEU:?}/$d"
  cp -a "/root/$d" "$HOMEU/$d"
done
# Installers leave absolute symlinks into /root (e.g. ~/.local/bin/claude, codex): point them at the copies.
find "$HOMEU" -type l | while read -r l; do
  t=$(readlink "$l"); case $t in /root/*) ln -sfn "$HOMEU${t#/root}" "$l" ;; esac
done
chown -R "$U:$U" "$HOMEU"
chmod 750 "$HOMEU"

# The server (root) creates and chowns workspace/<member> at start; the database is made root-only there too.
mkdir -p /opt/agent-chat/workspace
touch /etc/agent-chat.env && chmod 600 /etc/agent-chat.env
grep -q "^AGENT_USER=" /etc/agent-chat.env || echo "AGENT_USER=$U" >> /etc/agent-chat.env
echo "ok: $U ($HOMEU). Restart the service: systemctl restart agent-chat"
