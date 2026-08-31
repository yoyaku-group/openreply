# Meta App Review runbook

This is the canonical submission packet for OpenReply. Do not reuse the old
files under `/tmp`: they mixed production accounts, a forwarded Google Group,
and claims that the application could not demonstrate.

## Current verified state (2026-08-31)

- Parent Meta app: `Openreply`, ID `2480002912524211`, Business Portfolio
  `Yoyaku` (`1846751622045524`).
- Instagram app: `Openreply-IG`, ID `4047290928735084`. This is the value used
  by `INSTAGRAM_APP_ID`; it is not the parent Meta App ID.
- Duplicate empty Meta app `2214363202679910`: ignore during review and archive
  separately only after confirming it has no users, tokens, products or roles.
- Business Verification is verified. The parent app is still in Development
  mode (unpublished).
- OAuth requests four implemented Instagram Login permissions:
  `instagram_business_basic`, `instagram_business_manage_comments`,
  `instagram_business_manage_messages`, and
  `instagram_business_manage_insights`.
- All three production tokens can read the profile and conversations.
- All three accounts have a verified account-level `comments` + `messages`
  installation (`/{ig-user-id}/subscribed_apps`). This is not the same as the
  app-level fields configured under App Dashboard -> Webhooks.
- App-level audited fields are currently `comments`, `messaging_postbacks`, and
  `messaging_seen`; `messages` is missing and must be subscribed before the
  rehearsal.
- The fresh `@yoyaku.fr` token returns `data: []` for a media whose
  `comments_count` is 12, and a third-party live comment produced no webhook.
- OpenReply therefore records COMMENTS as `BLOCKED / COMMENTS_HIDDEN_BY_META`
  and refuses to activate COMMENT campaigns. There is no bypass.

The failed live comment had cumulative blockers: the app is unpublished, the
four permissions lack Advanced Access, and the app-level `messages` webhook
field is missing. Reconnecting a production account cannot fix any of those.

The external resolution is one App Review for the four implemented scopes,
plus publishing the parent app when Meta's workflow permits it. Do not submit
until callbacks, app-level webhooks, isolated reviewer access, and a real test
asset rehearsal are green.

## 1. Prepare a reviewer-safe workspace

Never give Meta access to the YOYAKU or Objects production workspaces.

1. Create a real mailbox such as `meta-review@interwave.live`. It must have its
   own inbox for the whole review period. Do not use the
   `appreview@yoyaku.fr -> ben@yoyaku.fr` forwarding group.
2. Sign in to OpenReply as Ben and open Settings.
3. Under **Isolated workspace**, create `Meta App Review`.
4. While that workspace is selected, invite `meta-review@interwave.live` as
   **Campaign editor**. Exact pending invitations are allowed through the global
   sign-in allowlist; no whole email domain is opened.
5. Sign in as the reviewer account in a private window and accept the invite.
   An editor can connect an Instagram account and create campaigns, but cannot
   disconnect accounts, manage the team, or access another workspace.
6. Connect a dedicated Instagram Professional test asset owned by the Meta app
   business. Do not connect `@yoyaku.fr`, `@yoyakurecordstore`, or
   `@objects.press` to this workspace.

Before recording, confirm the test asset has the required app role/tester role,
has accepted the Instagram tester invitation, and can complete a real
   comment-to-DM canary. If the canary is not green, do not fake the video and do
   not submit.

All `@yoyaku.fr` addresses are authorized by the production
`AUTH_ALLOWED_DOMAINS=yoyaku.fr,...` policy. That broad internal-domain access
does not replace the isolated reviewer mailbox and exact workspace invitation.

## 2. Complete the app settings

In Meta App Dashboard -> Settings -> Basic / Publish:

- App name: `OpenReply`
- Category: `Business and Pages`
- Contact email: `ben@yoyaku.fr`
- App domain: `openreply.yoyaku.fr`
- Website platform URL: `https://openreply.yoyaku.fr`
- Privacy policy: `https://openreply.yoyaku.fr/privacy`
- Terms: `https://openreply.yoyaku.fr/terms`
- Data deletion: `https://openreply.yoyaku.fr/data-deletion`
- App icon: upload
  `docs/meta-app-review/openreply-app-icon-1024.png` (1024 x 1024 PNG)
- Business Verification: verified legal entity and current documents
- Instagram webhook callback: `https://openreply.yoyaku.fr/api/webhook`
- OAuth redirect: `https://openreply.yoyaku.fr/api/instagram/callback`
- Deauthorize callback:
  `https://openreply.yoyaku.fr/api/instagram/deauthorize`
- Data deletion request callback:
  `https://openreply.yoyaku.fr/api/instagram/data-deletion`

The public `/data-deletion` instructions page and the signed-request callback
are two different Meta fields. Both must remain configured.

Under App Dashboard -> Instagram -> Webhooks, subscribe the app itself to at
least `comments`, `messages`, `messaging_postbacks`, and `messaging_seen`.
OpenReply separately verifies each connected account's `/subscribed_apps`
installation. Both layers must be green.

Test every public URL in a private window. Use the dedicated accepted tester
asset for the review rehearsal while the app is in Development mode. Switch the
app to Live at the step shown by Meta's current publication/review workflow;
never claim a successful public-user flow before it is actually Live.

## 3. Submit one review for the four implemented permissions

Do not request the legacy `instagram_manage_*` permissions, `public_profile`,
branded-content permissions, ads permissions, or content publishing. OpenReply
does not publish Instagram media today, so
`instagram_business_content_publish` must wait for an implemented, tested user
surface.

The single submission must contain all four of these permissions:
`instagram_business_basic`, `instagram_business_manage_comments`,
`instagram_business_manage_messages`, and
`instagram_business_manage_insights`. `instagram_business_basic` is a required
dependency of the other three. Remove the unused test-ready
`instagram_business_content_publish` and legacy `instagram_manage_comments`
from the use case unless a separately implemented feature later needs them.

### instagram_business_basic

```text
OpenReply uses instagram_business_basic after an Instagram Professional account
owner completes Instagram Business Login. The app reads the professional
account id, username, display name, profile picture, follower count, and the
account's own media metadata. OpenReply displays the connected profile in
Settings and lets the owner select one of their own posts or Reels for an
automation. This permission is also the required dependency for
instagram_business_manage_comments, instagram_business_manage_messages, and
instagram_business_manage_insights. OpenReply never asks for an Instagram
password and does not scrape Instagram.
```

Reviewer path: sign in -> Settings -> Connect Instagram -> complete consent ->
return to Settings and show the new account username and profile.

### instagram_business_manage_comments

```text
OpenReply receives comment webhook events for media owned by a connected
Instagram Professional account. The account owner selects a post or Reel and
configures an exact keyword or an any-comment trigger. OpenReply receives the
comment text to evaluate that configured trigger. A non-matching comment causes
no outbound action. A matching comment is deduplicated by campaign and comment,
queued, and may receive one initial private reply through POST
/{ig-user-id}/messages with recipient.comment_id. If enabled by the owner,
OpenReply may also post a public nested reply through POST
/{comment-id}/replies. OpenReply ignores comments authored by the connected
account itself.
```

The initial private reply is allowed once and within seven days of the comment.
If the recipient replies, subsequent messaging follows Meta's standard 24-hour
window.

### instagram_business_manage_messages

```text
OpenReply uses instagram_business_manage_messages for two user-initiated flows.
First, a person can send an exact keyword by Instagram Direct to a connected
professional account; OpenReply matches only an active keyword campaign and
sends the configured reply inside Meta's messaging window. Second, after a
comment-triggered initial private reply, OpenReply receives replies and button
postbacks so it can deliver the account owner's configured follow-up and show
the conversation in the workspace inbox. Unmatched normal messages are not
turned into campaign sends. Sends are queued, rate-limited, and deduplicated.
```

### instagram_business_manage_insights

```text
OpenReply reads reach and other available aggregate media insights for posts and
Reels owned by the connected Instagram Professional account. It displays these
metrics in that account's private dashboard and uses follower-count insights to
build the account's own historical trend. Insights are not sold, used to build
cross-customer audiences, or exposed to another workspace. The feature degrades
to unavailable when Meta does not expose a metric for a media type or account.
```

## 4. Record one honest end-to-end screencast

Record at 1080p with a readable browser. Hide notifications, unrelated tabs,
tokens, email links, and production customer data. The video should be two to
four minutes.

| Time | Action on screen                                                                                                                                               | Narration                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Open `https://openreply.yoyaku.fr/login` and sign in with the dedicated reviewer mailbox.                                                                      | “This is an isolated reviewer workspace with no production assets.”                                                  |
| 0:20 | Settings -> Connect Instagram, then complete Instagram Business Login using the dedicated Professional test account.                                           | Name the four permissions shown by the consent screen. Do not share Instagram credentials in the submission.         |
| 0:55 | Back in Settings, show username/profile and click **Verify capabilities**.                                                                                     | Explain that OpenReply verifies API visibility and reads back `comments`/`messages` subscriptions before activation. |
| 1:20 | Create a COMMENT campaign on a post owned by the connected test account, keyword `OPENREPLYTEST`, private message `Here is your link: https://yoyaku.fr/test`. | Explain exact matching and one initial private reply.                                                                |
| 1:55 | From a different Instagram account, comment `OPENREPLYTEST`.                                                                                                   | State that self-comments are intentionally ignored.                                                                  |
| 2:15 | Show the DM received and the `SENT` row in OpenReply DM Logs.                                                                                                  | Explain queueing and deduplication.                                                                                  |
| 2:40 | Open the Instagram Overview/analytics surface and show the connected account's aggregate metrics.                                                              | Explain that insights remain inside the workspace.                                                                   |
| 3:00 | End on Settings and the public Privacy/Data Deletion links.                                                                                                    | Explain disconnect and deletion controls.                                                                            |

Upload the video directly to Meta or as an unlisted video. Never use a private
URL that requires the reviewer's access to Ben's Google account.

## 5. Instructions for Developers

Replace the bracketed values only after the private-window rehearsal succeeds.

```text
Application URL: https://openreply.yoyaku.fr/login
Reviewer email: [meta-review@interwave.live]
Authentication: enter the reviewer email and open the magic link in that
mailbox. No password is used.

The account opens the isolated "Meta App Review" workspace. It has no access to
YOYAKU or Objects production data. In Settings, click Connect Instagram and use
your own Instagram Professional test account, or use the dedicated test asset
described in the secure credentials field supplied to Meta. Do not send us any
Instagram password.

After connection, Settings displays the Instagram username and profile. Create
a Comment campaign, choose a post owned by that connected account, enter the
exact keyword OPENREPLYTEST, set a private reply, and activate. From a different
Instagram account, comment OPENREPLYTEST on the selected post. The private reply
appears in Instagram and the delivery appears under DM Logs.

For insights, open Overview after selecting the connected account. The page
shows available aggregate media/account metrics.

Privacy: https://openreply.yoyaku.fr/privacy
Data deletion: https://openreply.yoyaku.fr/data-deletion
```

## 6. Pre-submit gate

All boxes must be true:

- Business Verification is complete.
- Parent Meta App ID is `2480002912524211`; Instagram App ID is
  `4047290928735084`.
- App mode is recorded accurately and the publication step is ready.
- App icon and all public URLs are accepted by Meta's URL debugger.
- Website platform URL is `https://openreply.yoyaku.fr`.
- Signed deauthorization and deletion callback URLs are saved and their GET
  readiness + invalid-signature tests pass.
- App-level webhook fields include `comments`, `messages`,
  `messaging_postbacks`, and `messaging_seen`.
- Reviewer mailbox receives its own magic link.
- Reviewer account has only the isolated workspace membership.
- Dedicated Instagram test asset has accepted its app/tester role.
- OAuth consent shows the same four scopes as `lib/meta/oauth.ts`.
- `GET /api/admin/instagram-capabilities?probe=1` is green for the test asset.
- A third-party comment produces a webhook, a `SENT` log, and a received DM.
- An inbound test DM produces a message webhook and appears in the intended
  reviewer workspace.
- Screencast contains that real successful flow.
- Descriptions match the shipped code and no unimplemented permission is
  requested.

The final **Submit** click and any Meta 2FA are browser-bound operator actions.

## 7. Approval and production canary

1. Do not reconnect all production accounts at once.
2. Reconnect only `@yoyaku.fr`.
3. In Settings, run **Verify capabilities**. COMMENTS must be `READY`, the
   reason must be `COMMENTS_VISIBLE` (or a real `WEBHOOK_RECEIVED`), and the
   verified fields must include `comments` and `messages`.
4. Activate one bounded canary campaign and comment from a distinct account.
5. Require a new WebhookEvent, a `SENT` DmLog, and a received DM.
6. Only then reconnect and verify `@yoyakurecordstore`, followed by
   `@objects.press`.

If the first canary fails, stop. Do not reconnect the remaining accounts.

## References

- Meta Instagram API collection: <https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api>
- Meta Graph API access levels: <https://developers.facebook.com/docs/graph-api/overview/access-levels/>
- OAuth source: `lib/meta/oauth.ts`
- Capability evidence: `lib/meta/capabilities.ts`
- Webhook receiver: `app/api/webhook/route.ts`
- Delivery worker: `lib/queue/dm-worker.ts`
