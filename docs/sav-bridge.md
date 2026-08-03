# Instagram SAV bridge

OpenReply owns Instagram ingress and delivery safety. It does not become a SAV
ticketing system:

- Gmail (`shop@yoyaku.fr`) is the customer-communication source of truth.
- YOFR is the case-lifecycle source of truth.
- `SavTransportItem` and `SavConversationFence` are encrypted, ephemeral
  transport state used for leases, stale-context checks, and idempotence.

The only client is `yoyaku-sav-engine` on the same host. It calls
`http://127.0.0.1:3048/api/internal/sav/*`; nginx deliberately returns 404 for
the entire public path. Generate one 32-byte token and install the same
`SAV_BRIDGE_TOKEN` in both `/opt/openreply/.env` and
`/opt/yoyaku-sav-engine/.env`. A missing, short, or mismatched token fails
closed. Mismatch logs contain only boolean metadata and a short fingerprint.

## Ingress and privacy

Signed Instagram `message` webhooks are parsed in memory. Echoes are ignored,
and `message.mid` is a unique deduplication key. Customer text is encrypted with
the existing `ENCRYPTION_KEY`; a keyed fingerprint is stored separately.
`WebhookEvent.payload` is redacted before it reaches PostgreSQL, including
text, usernames, postback data, and attachment metadata.

A newer inbound atomically supersedes older PENDING, CLAIMED, or REVIEWED rows
for that account/contact. Each conversation has a monotonic revision. Both
preflight and send require the item's revision to remain current, so a proposal
cannot be sent after a later DM arrives.

Terminal rows are purged after seven days. Non-terminal rows are bounded to 30
days. Claim context contains at most 10 messages, 30 days, and 20,000 text
characters. Attachments are represented only by `hasAttachments: true` and are
held for manual handling in v1.

## API

Every request uses `Authorization: Bearer $SAV_BRIDGE_TOKEN` and receives
`Cache-Control: no-store`. Responses follow `{success,data}`; errors expose a
stable code, not internal exception details.

### Health and claim

`GET /api/internal/sav/health` returns queue-state counts without customer
content.

`POST /api/internal/sav/claim`:

```json
{
  "workerId": "sav-engine-1",
  "limit": 5,
  "accountKeys": ["yoyaku_fr"]
}
```

`accountKeys` is optional and accepts only `yoyaku_fr` and
`yoyakurecordstore`. Filtering happens before any lease is acquired. This lets
the first canary claim only `yoyaku_fr` without holding or losing work for the
other account.

Each `data.items[]` contains:

```json
{
  "id": "...",
  "accountKey": "yoyaku_fr",
  "accountUsername": "yoyaku.fr",
  "accountInstagramId": "...",
  "senderInstagramId": "...",
  "senderUsername": "eelco",
  "conversationId": "...",
  "metaMessageId": "...",
  "text": "latest inbound text",
  "contextMessages": [
    {
      "direction": "INBOUND",
      "text": "earlier message",
      "at": "2026-07-09T09:51:00.000Z",
      "metaMessageId": "..."
    }
  ],
  "receivedAt": "2026-08-03T06:59:00.000Z",
  "replyWindowExpiresAt": "2026-08-04T06:59:00.000Z",
  "hasAttachments": false,
  "claimToken": "..."
}
```

The claim lease is ten minutes. A second worker cannot lease the same row.

### Review transitions

- `POST /api/internal/sav/items/:id/reviewed`
  with `{ "claimToken": "..." }` records that the Gmail review exists.
- `POST /api/internal/sav/items/:id/fail` with optional `claimToken` and a
  machine-readable `reason` moves the row to a terminal failure.
- `POST /api/internal/sav/items/:id/hold` has the same body shape and moves the
  row to manual hold. A REVIEWED row may be held without the expired claim
  token after a human Gmail command.

### Preflight and send

`POST /api/internal/sav/items/:id/preflight` rechecks the standard 24-hour
window and conversation revision. It returns one of:

- `READY` with a five-minute `deliveryToken`;
- `WINDOW_EXPIRED` (the SAV engine sends customer email only);
- `STALE_CONTEXT` (the engine creates a refreshed Gmail review).

`POST /api/internal/sav/items/:id/send`:

```json
{
  "deliveryToken": "...",
  "idempotencyKey": "gmail-message-id:approval-revision",
  "text": "the exact human-approved reply"
}
```

Send revalidates the window and revision, then reserves a rolling-hour circuit
slot under a database-wide transaction advisory lock before calling Meta's
normal direct message endpoint. `deliveryAttemptedAt` is written once during
that REVIEWED-to-SENDING reservation and never changed, so SENT, FAILED,
uncertain, and still-SENDING attempts all consume the same global budget. The
configured limit may be lowered but can never exceed the immutable hard cap of
10 attempts per hour. It never uses `HUMAN_AGENT`. Results are `SENT`,
`WINDOW_EXPIRED`, `STALE_CONTEXT`, or `ALREADY_SENT`.

SENDING is deliberately at-most-once. If the process dies after Meta accepts a
message but before PostgreSQL records its id, retries return `ALREADY_SENT`
instead of risking a duplicate. That uncertain state requires human
reconciliation.

## Bounded backfill

`POST /api/internal/sav/backfill` accepts an order reference and optional
account key:

```json
{"orderReference":"745614","accountKey":"yoyaku_fr"}
```

It searches at most 50 conversations and 20 messages per conversation. The
reference identifies the conversation, but the latest inbound message becomes
the queued item and therefore owns the reply window. This matters when an old
message names the order and a fresh follow-up says only “that order”. Up to ten
chronological inbound/outbound context messages are encrypted onto the item.
The response reports only found/imported ids and never returns or logs text.
