# Calendar lifecycle and delivery authorization

Events owns publication intent, material source revision and delivery eligibility.
OpenReply stores review drafts; exact Instagram binding and human activation remain
required. A normal sync can retain an unchanged human activation, never create one.

The authenticated source feed contains `intents`, explicit `retirements` and
`snapshot_complete`. Each intent includes `source_revision`, `delivery_allowed`
and `blocking_reasons`. Revision, date, status, post, CTA or destination changes
pause an active campaign for review. An explicit retirement pauses only the matching
Calendar publication in its mapped workspace. No retirement is inferred from an
empty, partial, invalid or failed response. A formerly representable publication
whose CTA/URL disappears must receive an explicit retirement from Events.

Before every worker Meta send (public reply, opening DM, follow prompt, direct reveal,
text fallback and appreciation follow-up), the worker locks and rereads the Automation
row. Inactive rows are denied. Calendar rows additionally require the job's source
revision to match, the exact workspace mapping, a locally allowed source, and a fresh
Events `POST delivery-check` response with `allowed:true`, the same revision and no
blocking reasons. This endpoint is derived only by replacing the final
`automation-intents` segment of `CALENDAR_INTENTS_URL`; it uses the same configured
origin and `x-internal-secret`. Redirects are refused. No new secret is introduced.
Manual and other sources have no Events dependency.

The lock stays held during dispatch, ordering it against sync and staff pause writes.
Source checks time out after 5 seconds and Meta sends after 20 seconds. Transactions
have a 30-second timeout. Every subsequent message obtains its own fresh check.
A Meta request already dispatched before a cancellation cannot be recalled: there
is no distributed transaction between Events, OpenReply and Meta. Network failure
is not converted into a button-to-text fallback.

## Deployment recipe

Status: prepared and tested locally; no production deployment or Meta send performed
by this implementation task. Parent integration owns deployment.

1. Deploy Events' lifecycle feed and `delivery-check` first. Verify both endpoints
   from the worker network with the existing configured secret without printing it;
   a nonexistent publication must return a denied response. Check that the source
   URL is the canonical `/api/internal/publications/automation-intents` endpoint.
2. Merge the OpenReply PR after required CI. On `yoyaku-automation`, check drift at
   `/opt/openreply`: clean tracked tree, expected deployed commit/image tag and healthy
   web/worker. Record previous image tag and a successful canonical database backup
   (`bash deploy/backup.sh`). Never print `.env` or replace its credentials.
3. Stop the Calendar cron timer/service and old worker before schema migration:
   `sudo systemctl stop openreply-cron.timer openreply-cron.service` and
   `docker compose -f compose.production.yml stop worker` from `/opt/openreply`.
   This prevents an old worker's in-memory job from escaping the new guard.
4. Run the existing canonical `bash deploy/deploy.sh`. It fetches main, records the
   image tag, builds the web/worker images and runs Compose. The `migrate` service
   executes `npm run db:migrate`; worker/web depend on its successful completion.
   Migration `20260909150000_calendar_delivery_lifecycle` adds five fields and pauses
   existing active Calendar campaigns once. Manual campaigns and archives remain.
5. Check migration status and its successful container exit, `/api/health` with
   `worker.healthy:true`, exact running image tags, and authenticated lifecycle sync.
   Verify aggregate Calendar revisions/paused counts and absence of unexpected sends.
   Resume `openreply-cron.timer`. An identical second sync must not activate anything.
   Review/activate only the explicitly selected canary through the existing human
   workflow; do not send a real test message as part of deployment.

Rollback: stop cron and worker first, keep Calendar campaigns paused, set
`OPENREPLY_IMAGE_TAG=<recorded-previous-tag> docker compose -f compose.production.yml up -d`.
The added columns are backwards compatible and must not be removed. Do not restore
prior activations or resume the old Calendar sync automatically: the previous image
lacks the delivery guard. Other sources can continue on the previous image.

## Verification

Node 22; `npm run db:generate`, `npm run typecheck`, `npm run lint`, `npm test`,
`npm run build`, and `npm audit --omit=dev --audit-level=high`.

For real PostgreSQL concurrency verification, create an isolated local database
whose name contains `test`, apply `prisma db push` with its DATABASE_URL, then run
`OPENREPLY_TEST_DATABASE_URL=<local-test-url> npm test`.
Tests preserve isolated fixtures; migration validation uses a rolled-back schema.
No real Meta token, recipient, Redis worker or remote delivery is needed.
