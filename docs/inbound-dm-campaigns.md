# Exact inbound DM campaigns

Use an inbound DM campaign when the Instagram post was published by another
account and the connected account is only a collaborator. Comment-private-reply
automation is intentionally limited to media the connected account token can
read. An inbound campaign instead responds inside a conversation the user
starts with the connected professional account.

## Matching contract

- One exact token is required; `matchAnyWord` is unavailable.
- Matching uses NFKC normalization, trimming, lowercase comparison, one
  optional leading `#`, and one optional final `.`, `!`, or `?`.
- Sentences, reactions, empty messages, and messages with attachments never
  trigger a campaign.
- Only one active campaign may own a normalized keyword on an Instagram
  account. The webhook and worker both fail closed if configuration becomes
  ambiguous.
- Delivery is limited to one successful DM per campaign and Instagram user.
  The worker also enforces the workspace quota, account rate limit, and Meta's
  24-hour user-initiated messaging window.

Normal messages are not auto-replied to. They continue through the account's
existing inbox/SAV routing.

## MB059 campaign

Connect the professional account `@minibarmusic` through the existing Settings
OAuth flow, then create this campaign as a draft:

- Name: `MB059 DM keyword`
- Trigger: `Exact keyword sent by Instagram DM`
- Keyword: `MB059`
- Message: `Sweely's Le chat botté e.p. (MB059) is available to pre-order on YOYAKU.`
- Button: `Pre-order MB059`
- Destination: `https://yoyaku.io/release/sweely-le-chat-botte-e-p-mb059/`
- Opening DM, follow gate, public reply, and follow-up: disabled

Use this public CTA only after the canary succeeds:

> Want MB059? Send "MB059" in DM to @minibarmusic and we'll send you the direct pre-order link.

Until the automation is live, use this saved manual reply:

> Here you go. Sweely's Le chat botté e.p. (MB059) is available to pre-order on YOYAKU: https://yoyaku.io/release/sweely-le-chat-botte-e-p-mb059/

## Rollout and rollback

1. Keep the existing inaccessible comment campaign paused; do not delete it.
2. Save the inbound campaign as a draft.
3. Activate it without publishing the CTA and send exactly `MB059` from one
   controlled external Instagram account.
4. Verify one DM, the button redirect, one tracked click, no second DM after a
   repeated keyword, and no automation response to a normal sentence.
5. Publish the CTA only after all checks pass. Do not bulk-message existing
   commenters.

Rollback is immediate: pause the inbound campaign. The additive database enum,
column, and status may remain in place when rolling application code back.
