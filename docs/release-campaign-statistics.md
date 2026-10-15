# Release publication campaign statistics

The authenticated internal endpoint `/api/internal/campaign-stats` is read-only.
It never creates or activates a campaign, changes its binding or sends a DM.

An exact lookup requires `sku`, `workspace_key`, `account_owner`, and at least
one of `publication_key`, `post_id` or `automation_id`. All supplied identities
must match the same automation. Workspace IDs come from the existing
`CALENDAR_WORKSPACE_IDS` registry; the request cannot select another tenant by
name or fall back across accounts. The known account-to-workspace mapping is the
same as the Calendar intent adapter.

Zero or multiple matches return no automation and an explicit resolution. A
legacy SKU-only caller receives `scope_required`; the newest campaign is never
used as a substitute for a missing phase/publication binding. Returned counts
belong to the exact automation/workspace and include only sent DMs. No recipient
identities or message content are returned. Responses use `private, no-store`.

Consumers must include the whole scope in any local cache key and require an
exact echoed scope before decorating a release phase with statistics. An older
provider response without the scope is unavailable evidence, not a match.

Authentication uses the existing dedicated `CRON_SECRET`, minimum 32 characters,
with a constant-time comparison. An absent secret cannot authorize the literal
`Bearer undefined`, and a general NextAuth session secret is not a fallback.
