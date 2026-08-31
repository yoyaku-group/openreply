#!/usr/bin/env bash
set -euo pipefail

payload="$(curl \
  --fail \
  --silent \
  --show-error \
  --max-time 15 \
  https://openreply.yoyaku.fr/api/health)"

node -e '
const health = JSON.parse(process.argv[1]);
const blocked = health?.checks?.instagram_capabilities?.active_comment_blocked_count;
if (health.status !== "ok") process.exit(1);
if (typeof blocked !== "number") process.exit(1);
if (blocked > 0) process.exit(1);
' "$payload"
