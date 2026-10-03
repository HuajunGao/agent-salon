#!/usr/bin/env bash
# Deploy the committed HEAD to the home server and restart the service. Data (data/, workspace/) is untouched.
#   deploy/push.sh [user@host]      default: root@server.lan
set -euo pipefail
host=${1:-root@server.lan}
cd "$(dirname "$0")/.."
git archive --format=tar.gz HEAD | ssh "$host" 'set -e
  tar -xzf - -C /opt/agent-chat
  cp /opt/agent-chat/deploy/agent-chat.service /etc/systemd/system/ && systemctl daemon-reload
  systemctl restart agent-chat && sleep 2 && systemctl is-active agent-chat'
echo "deployed $(git rev-parse --short HEAD) to $host"
