# Instagram capability diagnostics

OpenReply no longer treats a comma-separated OAuth scope cache or a successful
subscription POST as proof that a feature works.

## Registry

`InstagramCapability` stores one row per connected account and feature:

- kinds: BASIC, COMMENTS, MESSAGES, INSIGHTS, CONTENT_PUBLISH
- states: UNKNOWN, READY, BLOCKED, ERROR, STALE
- evidence: reason, redacted HTTP/sample facts, checked time, last success time

`InstagramAccount.subscribedFields` stores the fields read back from Meta's
`GET /{ig-user-id}/subscribed_apps`. The legacy `webhookSubscribed` and
`scopes[]` fields remain transitional projections only.

## Feature gates

- COMMENT automation: BASIC READY + COMMENTS READY + fresh verified `comments`
  subscription
- inbound DM automation: BASIC READY + MESSAGES READY + fresh verified
  `messages` subscription
- insights: BASIC READY + INSIGHTS READY; no webhook dependency

UNKNOWN, BLOCKED, ERROR, and STALE all fail closed for activation. There is no
environment-variable bypass.

## Functional evidence

The Instagram Login rail does not provide a reliable permissions listing for
these tokens, so OpenReply makes bounded read-only calls:

- `GET /me` proves BASIC.
- `GET /me/conversations` proves MESSAGES.
- `GET /me/media?fields=id,comments_count&limit=50`, then
  `GET /{media-id}/comments?limit=1`, proves COMMENTS.
- `GET /{media-id}/insights?metric=reach` proves INSIGHTS.

Comment interpretation is deliberate:

- a sampled media has comments and the API returns a visible row -> READY /
  COMMENTS_VISIBLE
- `comments_count > 0` but the comments collection is empty -> BLOCKED /
  COMMENTS_HIDDEN_BY_META
- no sampled media has comments -> UNKNOWN / NO_COMMENTED_MEDIA
- permission HTTP failure -> BLOCKED / COMMENTS_API_DENIED
- transient/upstream failure -> ERROR or the prior cached snapshot with
  `probeError`

Webhook arrival is positive runtime evidence and promotes the corresponding
COMMENTS or MESSAGES capability to READY / WEBHOOK_RECEIVED.

## Operator endpoints

- public roll-up, DB-only: `GET /api/health`
- authenticated workspace detail: `GET /api/admin/instagram-capabilities`
- forced bounded probe: `GET /api/admin/instagram-capabilities?probe=1`
- one account: `GET /api/admin/instagram-capabilities?account=<db-id>&probe=1`

The systemd healthcheck fails if any active COMMENT campaign belongs to an
account that is not comment-ready. The scheduled capability cron refreshes
evidence without exposing Meta calls through the public health endpoint.

## 2026-08-31 incident evidence

For fresh `@yoyaku.fr` media `18095156432032069`, Meta reported
`comments_count=12` but `GET /comments` returned HTTP 200 with `data=[]`.
`GET /subscribed_apps` simultaneously showed `comments` and `messages`. A
comment from distinct account `@benjaminbelaga` produced no WebhookEvent,
ProcessedComment, or DmLog while Postgres, Redis, queue, web, and worker were
healthy.

This proves that reconnecting or repeating the subscription POST is not a fix.
The token/app access state is blocked upstream. Follow
`docs/meta-app-review-brief.md` and canary only one production account after
approval.
