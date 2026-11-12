# YOYAKU production deployment

OpenReply runs as four isolated services on `yoyaku-automation`:

- Next.js web/API on host loopback port `3048`
- long-running BullMQ worker
- dedicated PostgreSQL 16
- dedicated Redis 7

The public edge is `https://openreply.yoyaku.fr` through nginx. PostgreSQL and
Redis have no host ports. Persistent data and local backups live under
`/mnt/data/openreply`. Daily PostgreSQL dumps are retained locally for 14 days
and replicated to `yoyaku-hetzner:/opt/backups/openreply-automation` with
30-day retention so the recovery copy does not share the application host.

## Deploy

1. Clone this fork into `/opt/openreply`.
2. Copy `deploy/openreply.env.example` to `.env`, replace every placeholder,
   and set mode `0600`.
   Generate `SAV_BRIDGE_TOKEN` once and install the identical value in both
   `/opt/openreply/.env` and `/opt/yoyaku-sav-engine/.env`; those are its only
   consumers. The public nginx vhost returns 404 for `/api/internal/sav/*`.
3. Create `/mnt/data/openreply/{postgres,redis,backups}` with ownership suitable
   for the official container images.
4. Run:

   ```bash
   docker compose -f compose.production.yml config --quiet
   docker compose -f compose.production.yml build
   docker compose -f compose.production.yml up -d
   ```

5. Install the nginx vhost and systemd units from `deploy/`.
6. Confirm `/api/health` returns `status: ok` and `worker.healthy: true`.

## Day-2 deploys

After the initial install, ship a new `main` with:

```bash
ssh yoyaku-automation 'cd /opt/openreply && bash deploy/deploy.sh'
```

The script pulls `main`, aligns `OPENREPLY_IMAGE_TAG` in `.env` to the deployed
commit (the tag is the deploy marker — never edit it by hand), builds,
recreates, and smokes `/api/health`. Rollback is
`OPENREPLY_IMAGE_TAG=<previous-tag> docker compose -f compose.production.yml up -d`.

The populated `.env` must never enter Git. `ENCRYPTION_KEY` is irreplaceable:
losing it forces every Instagram account to reconnect.

The Instagram SAV bridge is documented in
[`docs/sav-bridge.md`](../docs/sav-bridge.md). Start the engine with
`accountKeys: ["yoyaku_fr"]` for the first canary; this leaves
`yoyakurecordstore` rows unclaimed until the canary is expanded deliberately.

## Copywriter host worker (AI copy)

The app queues `CopyGeneration` rows; this host worker transports them to the
subscription cascade. Install (the app container itself never runs the
cascade):

Install and rotation go through one script, run as root on the host. It
writes the shared token to both consumers in the same run (rules/75), never
prints it and never passes it on a command line:

```bash
cd /opt/openreply
bash deploy/copywriter/install.sh token    # COPYWRITER_BRIDGE_TOKEN in .env and
                                           # /etc/openreply/copywriter.env, recreate
                                           # web + worker, restart the unit if present
bash deploy/copywriter/install.sh unit     # install the unit with this host's
                                           # cascade LoadCredential lines, enable it
bash deploy/copywriter/install.sh enable   # COPYWRITER_ENABLED=true, recreate web
bash deploy/copywriter/install.sh status   # health without token (401) and with it (200)
```

Consumers of `COPYWRITER_BRIDGE_TOKEN`:

| Consumer | File | Reads it as |
|---|---|---|
| App (web + worker containers) | `/opt/openreply/.env` | compose `env_file` |
| Host worker `openreply-copywriter.service` | `/etc/openreply/copywriter.env` (0600) | systemd `EnvironmentFile` |

The worker env file also holds `OPENREPLY_INTERNAL_URL=http://127.0.0.1:3048`
and `COPYWRITER_WORKDIR=/var/lib/openreply-copywriter`. That directory is
created by `StateDirectory=openreply-copywriter`; the cascade must never share
it with another job.

`unit` copies the `LoadCredential=` lines from
`/etc/systemd/system/dkay-credits-sync.service`, the host's working cascade
unit, in place of the commented placeholder in
`deploy/systemd/openreply-copywriter.service`. It refuses to install when it
finds none.

Rotating the token is `install.sh token` again: both files change together
and the unit restarts. The health route answers `pending` / `claimed` /
`done` / `failed` queue counts and the active prompt version per workspace.

The public vhosts (`openreply.yoyaku.fr`, `openreply.objects.press`) must
answer 404 on `/api/internal/copywriter/`, like the SAV bridge (see
`deploy/nginx/openreply.yoyaku.fr.conf`).

Kill switches: `systemctl stop openreply-copywriter` (the queue stops
draining; campaigns keep their standard copy) or
`bash deploy/copywriter/install.sh disable` (`COPYWRITER_ENABLED=false`: no
new rows are queued, the assistant uses the standard copy).

Purge: the `purge-copywriter` cron route (already in `deploy/cron.sh`)
deletes generation rows older than 90 days.
