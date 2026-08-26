# Instagram collaborative-post native transport — laboratory E2E

Date: 2026-08-27

## Scope

Validate the exact technical path without Sweely credentials:

1. Read comments from Sweely-owned collaborative media.
2. Detect a comment from a controlled recipient.
3. Create one native Instagram DM from `@yoyakurecordstore` to that recipient.

No campaign, queue, OpenReply worker, historical backfill, or customer message was enabled.

## Evidence

- `instagrapi.media_comments_public_gql("DceFmD3iLt7")` read public comments from the target post on the first request.
- A single `@benjaminbelaga` test comment was posted. The authenticated native reader from `@yoyakurecordstore` then returned 50 comments and found exactly one comment from `@benjaminbelaga`.
- A one-shot, persisted `direct_send()` canary from `@yoyakurecordstore` created a direct thread with `@benjaminbelaga`; the sender-side thread contains the exact test text.
- The recipient-side private session returned `login_required`, so this run cannot independently prove inbox rendering from the recipient session.

## Result

The technical route is feasible for the requested ownership shape:

`Sweely-owned Collab post -> native comment reader -> commenter native ID -> native DM from @yoyakurecordstore`

It is not an official Meta implementation and is not production-ready. Session validity is volatile, recipient message-request policy can prevent visibility, and Instagram can challenge or restrict the account. Treat the sender-side thread evidence as transport acceptance, not delivery proof.

## Non-negotiable production gates

- Keep the native provider feature-flagged and isolated from the official Meta path.
- Persist an at-most-once send attempt before network I/O; never retry `STARTED`/unknown sends automatically.
- Stop immediately on `login_required`, challenge, feedback, 429, or any unknown transport state.
- Require a human-reviewed canary and recipient-visible delivery proof before any rollout.
- Do not implement historical-comment backfill or bulk sends under this experiment.

