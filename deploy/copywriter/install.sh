#!/usr/bin/env bash
# Canonical install and rotation of the copywriter host bridge (rules/75: one
# script touches every consumer of the shared secret in the same run).
# Runs ON yoyaku-automation as root.
#
# Consumers of COPYWRITER_BRIDGE_TOKEN:
#   1. the app    /opt/openreply/.env            (compose env_file of web + worker)
#   2. the worker /etc/openreply/copywriter.env  (openreply-copywriter.service)
#
# Usage:
#   bash deploy/copywriter/install.sh token     # generate or rotate the token in both
#                                               # files, recreate web, restart the
#                                               # worker unit when installed, smoke
#   bash deploy/copywriter/install.sh unit      # install the systemd unit with the
#                                               # host's cascade LoadCredential lines
#   bash deploy/copywriter/install.sh enable    # COPYWRITER_ENABLED=true  + recreate web
#   bash deploy/copywriter/install.sh disable   # COPYWRITER_ENABLED=false + recreate web
#   bash deploy/copywriter/install.sh status    # health route with and without the token
#
# The token is never printed and never placed on a command line: it travels
# through the environment of child processes (readable by root only) and is
# written through a temp file + rename in the target directory.
set -euo pipefail

readonly APP_DIR="/opt/openreply"
readonly APP_ENV="$APP_DIR/.env"
readonly WORKER_ENV_DIR="/etc/openreply"
readonly WORKER_ENV="$WORKER_ENV_DIR/copywriter.env"
readonly COMPOSE="compose.production.yml"
readonly UNIT="openreply-copywriter.service"
readonly UNIT_SRC="$APP_DIR/deploy/systemd/$UNIT"
readonly UNIT_DST="/etc/systemd/system/$UNIT"
# The host's working cascade unit: its LoadCredential lines are the reference.
readonly CASCADE_REF_UNIT="/etc/systemd/system/dkay-credits-sync.service"
# Only the credentials claude_cascade.py itself reads (zai.env for GLM,
# minimax-max.env for MiniMax). Anything else the reference unit loads, now or
# later, never reaches the copywriter worker.
readonly CASCADE_CRED_IDS="zai.env minimax-max.env"
readonly INTERNAL_URL="http://127.0.0.1:3048"
readonly HEALTH_PATH="/api/internal/copywriter/health"
readonly WORKDIR="/var/lib/openreply-copywriter"

die() { echo "install.sh: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
cd "$APP_DIR"

# set_key FILE KEY VALUE: replace or append KEY=VALUE, keep every other line,
# keep the file's mode and owner (0600 root for a new file).
set_key() {
  local file="$1" key="$2" value="$3" tmp
  tmp=$(mktemp "$(dirname "$file")/.$(basename "$file").XXXXXX")
  if [ -f "$file" ]; then
    chmod --reference="$file" "$tmp"
    chown --reference="$file" "$tmp"
    K="$key" V="$value" awk '
      BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
      index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
      { print }
      END { if (!done) print k "=" v }' "$file" > "$tmp"
  else
    chmod 0600 "$tmp"
    K="$key" V="$value" awk 'BEGIN { print ENVIRON["K"] "=" ENVIRON["V"] }' > "$tmp"
  fi
  mv -f "$tmp" "$file"
}

# Read one key from a file without echoing it; result in REPLY_VALUE.
read_key() {
  local file="$1" key="$2"
  REPLY_VALUE=$(K="$key" awk 'index($0, ENVIRON["K"] "=") == 1 { sub(/^[^=]*=/, ""); v = $0 } END { print v }' "$file")
}

recreate_web() {
  # .env changed: compose recreates the services whose environment changed.
  # migrate is left out on purpose (it only runs on a deploy).
  docker compose -f "$COMPOSE" up -d --no-deps web worker >/dev/null
  local status=""
  for _ in $(seq 1 30); do
    status=$(curl -s -m 5 "$INTERNAL_URL/api/health" | grep -o '"status":"ok"' || true)
    [ -n "$status" ] && break
    sleep 2
  done
  [ -n "$status" ] || die "app health check failed after recreate"
  echo "app: healthy"
}

# HTTP status of the health route, with the stored token (auth) or without.
health_code() {
  local mode="$1"
  if [ "$mode" = "auth" ]; then
    read_key "$APP_ENV" COPYWRITER_BRIDGE_TOKEN
    [ -n "$REPLY_VALUE" ] || { echo "none"; return; }
    # The header comes from a process-substitution file, never argv.
    curl -s -o /dev/null -w '%{http_code}' -m 5 \
      -H @<(printf 'Authorization: Bearer %s\n' "$REPLY_VALUE") \
      "$INTERNAL_URL$HEALTH_PATH"
    REPLY_VALUE=""
  else
    curl -s -o /dev/null -w '%{http_code}' -m 5 "$INTERNAL_URL$HEALTH_PATH"
  fi
}

cmd_status() {
  echo "health without token: $(health_code none) (expect 401)"
  echo "health with token:    $(health_code auth) (expect 200)"
  if systemctl list-unit-files "$UNIT" >/dev/null 2>&1 && [ -f "$UNIT_DST" ]; then
    echo "worker unit:          $(systemctl is-active "$UNIT" || true)"
  else
    echo "worker unit:          not installed"
  fi
}

cmd_token() {
  install -d -m 0750 "$WORKER_ENV_DIR"
  local token
  token=$(openssl rand -base64 32 | tr -d '\n')
  [ "${#token}" -ge 32 ] || die "token generation failed"
  set_key "$APP_ENV" COPYWRITER_BRIDGE_TOKEN "$token"
  set_key "$WORKER_ENV" COPYWRITER_BRIDGE_TOKEN "$token"
  token=""
  set_key "$WORKER_ENV" OPENREPLY_INTERNAL_URL "$INTERNAL_URL"
  set_key "$WORKER_ENV" COPYWRITER_WORKDIR "$WORKDIR"
  # Both files now hold the same value; prove it without printing it.
  local a b
  read_key "$APP_ENV" COPYWRITER_BRIDGE_TOKEN; a=$(printf '%s' "$REPLY_VALUE" | sha256sum)
  read_key "$WORKER_ENV" COPYWRITER_BRIDGE_TOKEN; b=$(printf '%s' "$REPLY_VALUE" | sha256sum)
  REPLY_VALUE=""
  [ "$a" = "$b" ] || die "token mismatch between the two consumers"
  echo "token: written to both consumers (digests match)"
  recreate_web
  # A restart is safe mid-generation: SIGTERM lets the worker finish its
  # current item, and a row whose result is refused (old token) stays CLAIMED
  # until its 60 s lease expires, then claimCopyItems hands it out again.
  if [ -f "$UNIT_DST" ]; then
    systemctl restart "$UNIT"
    echo "worker unit: restarted"
  fi
  cmd_status
}

cmd_unit() {
  [ -f "$UNIT_SRC" ] || die "missing $UNIT_SRC"
  [ -f "$CASCADE_REF_UNIT" ] || die "missing reference cascade unit $CASCADE_REF_UNIT"
  [ -f "$WORKER_ENV" ] || die "run 'install.sh token' first"
  local tmp
  tmp=$(mktemp)
  # Replace the commented LoadCredential placeholders with the reference
  # unit's lines for the allowlisted cascade credentials (copied, never
  # printed). The credential ID is the text between "=" and the first ":".
  awk -v ref="$CASCADE_REF_UNIT" -v ids="$CASCADE_CRED_IDS" '
    BEGIN { n = split(ids, list, " "); for (i = 1; i <= n; i++) allow[list[i]] = 1 }
    /^# LoadCredential=/ {
      if (!done) {
        while ((getline line < ref) > 0) {
          if (line !~ /^LoadCredential(Encrypted)?=/) continue
          id = line; sub(/^[^=]*=/, "", id); sub(/:.*/, "", id)
          if (id in allow) print line
        }
        done = 1
      }
      next
    }
    { print }' "$UNIT_SRC" > "$tmp"
  local found
  found=$(grep -c '^LoadCredential' "$tmp" || true)
  if [ "$found" -ne "$(wc -w <<<"$CASCADE_CRED_IDS")" ]; then
    rm -f "$tmp"
    die "expected one LoadCredential line per cascade credential ($CASCADE_CRED_IDS) in $CASCADE_REF_UNIT, found $found"
  fi
  install -m 0644 "$tmp" "$UNIT_DST"
  rm -f "$tmp"
  systemctl daemon-reload
  systemctl enable --now "$UNIT" >/dev/null
  sleep 3
  echo "worker unit: $(systemctl is-active "$UNIT" || true)"
}

cmd_switch() {
  set_key "$APP_ENV" COPYWRITER_ENABLED "$1"
  echo "COPYWRITER_ENABLED=$1"
  recreate_web
}

case "${1:-}" in
  token) cmd_token ;;
  unit) cmd_unit ;;
  enable) cmd_switch true ;;
  disable) cmd_switch false ;;
  status) cmd_status ;;
  *) die "usage: install.sh token|unit|enable|disable|status" ;;
esac
