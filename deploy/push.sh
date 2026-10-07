#!/usr/bin/env bash
# Deploy the committed HEAD to the home server and restart every instance (one per /etc/agent-chat-<name>.env). Data (data/, workspace/) is untouched.
#   deploy/push.sh [user@host]      default: root@server.lan
set -euo pipefail
host=${1:-root@server.lan}
cd "$(dirname "$0")/.."
git archive --format=tar.gz HEAD | ssh "$host" 'set -e
  tar -xzf - -C /opt/agent-chat
  cp /opt/agent-chat/deploy/agent-chat@.service /etc/systemd/system/ && systemctl daemon-reload
  units=$(for f in /etc/agent-chat-*.env; do n=${f#/etc/agent-chat-}; echo "agent-chat@${n%.env}"; done)
  systemctl restart $units && sleep 2 && systemctl is-active $units'
echo "deployed $(git rev-parse --short HEAD) to $host"
