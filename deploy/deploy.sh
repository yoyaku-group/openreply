#!/usr/bin/env bash
# Canonical OpenReply deployment (runs ON yoyaku-automation).
# Keeps OPENREPLY_IMAGE_TAG aligned with the deployed commit so the running
# image tag is a truthful deploy marker, then builds, recreates, and smokes.
#
# Usage: ssh yoyaku-automation 'cd /opt/openreply && bash deploy/deploy.sh'
# Rollback: OPENREPLY_IMAGE_TAG=<previous-tag> docker compose -f compose.production.yml up -d
set -euo pipefail

readonly APP_DIR="/opt/openreply"
readonly COMPOSE="compose.production.yml"

cd "$APP_DIR"

echo "== 1/6 Fresh checkout =="
git fetch --quiet origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  git pull --ff-only origin main
  LOCAL=$(git rev-parse HEAD)
fi
TAG=$(git rev-parse --short HEAD)
echo "deploying commit $TAG"

echo "== 2/6 Image tag marker =="
if grep -q '^OPENREPLY_IMAGE_TAG=' .env; then
  sed -i "s|^OPENREPLY_IMAGE_TAG=.*|OPENREPLY_IMAGE_TAG=$TAG|" .env
else
  printf '\nOPENREPLY_IMAGE_TAG=%s\n' "$TAG" >> .env
fi
echo "OPENREPLY_IMAGE_TAG=$TAG"

echo "== 3/6 Compose config =="
docker compose -f "$COMPOSE" config --quiet

echo "== 4/6 Build =="
docker compose -f "$COMPOSE" build

echo "== 5/6 Recreate =="
docker compose -f "$COMPOSE" up -d

echo "== 6/6 Smoke =="
for _ in $(seq 1 30); do
  STATUS=$(curl -s -m 5 http://127.0.0.1:3048/api/health | grep -o '"status":"ok"' || true)
  [ -n "$STATUS" ] && break
  sleep 2
done
if [ -z "$STATUS" ]; then
  echo "HEALTH CHECK FAILED — rollback: OPENREPLY_IMAGE_TAG=<previous> docker compose -f $COMPOSE up -d"
  exit 1
fi
WORKER=$(curl -s -m 5 http://127.0.0.1:3048/api/health | grep -o '"worker":{"healthy":true' || true)
[ -n "$WORKER" ] && echo "worker: healthy" || echo "worker: NOT healthy yet (may still be booting)"

echo "== Receipt =="
echo "commit:   $TAG"
echo "tag set:  $TAG"
echo "health:   ok"
echo "time:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
