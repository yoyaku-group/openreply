# Instagram scope probe — known false negatives + workaround

**Status** : verdict live confirmé le 2026-08-31. Le bypass d'activation est
désactivé en production (`OPENREPLY_COMMENTS_SCOPE_ADVISORY=false`) et aucune
campagne COMMENT non archivée n'est active.

## The probe

`lib/meta/client.ts::probeInstagramLoginScopes` infers which Instagram scopes a token actually has by issuing functional smoke calls instead of consulting `/me/permissions` (which does not exist on the `graph.instagram.com` rail) or `/debug_token` (which refuses to parse Instagram Login tokens). The probe is structural, not authoritative.

Smoke calls:
- `GET /me` → assumes `instagram_business_basic` is granted if 200
- `GET /me/conversations` → assumes `instagram_business_manage_messages` is granted if 200
- `GET /{media-id}/comments` (on a recent media with `comments_count > 0`) → assumes `instagram_business_manage_comments` is granted if `data[]` is non-empty

## Three documented false-negative modes

1. **No recently-commented media** : the probe picks the most recent media via `/me/media?limit=25`, then picks one with `comments_count > 0`. If the account has zero commented media in the last 25, the probe never even attempts `/{media-id}/comments` and `manage_comments` is silently marked absent.
2. **Rate-limit / transient error on the smoke call** : the catch block sets `scopes = []` and `lastScopeProbeAt = null`. Empty scopes suppress the campaign banner, but the next live `assertCommentScope` retry re-runs the probe and the cycle repeats.
3. **Standard Access vs Advanced Access asymmetry** : on `graph.instagram.com`, even a token that *requests* `manage_comments` via the OAuth URL may receive a 200 + `data: []` response until Meta has granted Advanced Access via App Review. The probe cannot distinguish "scope absent" from "scope present but zero comments on the sampled media".

## Operational consequences

For our 3 IG pros (`@yoyaku.fr`, `@yoyakurecordstore`, `@objects.press`) the cached `scopes` column has consistently shown `[instagram_business_basic, instagram_business_manage_messages]` (no `manage_comments`) even after disconnect + reconnect. As a result, `commentsScopeError` was rejecting every campaign create/update on `@yoyaku.fr` with a 400 banner ("this campaign would never trigger").

A live probe on 2026-08-30 confirmed that `/{media-id}/comments` returns 200 +
empty data. Le test humain du 2026-08-31 a levé l'ambiguïté : le commentaire
`Yes` de `@atelier14.paris` sur le post Objects `DOTUhHSjDPY` n'a produit aucun
webhook `comments` et aucun `DmLog`, alors que `/api/health`, Postgres, Redis,
la queue et le worker étaient sains. Le scope est donc réellement absent.

## Bypass historique (commits `534eed5`, `649b119`)

`app/api/automations/route.ts::commentsScopeError` was downgraded from a hard 400 to an advisory `console.warn` + `return null`. A campaign can now be saved even when the cached `scopes` lacks `manage_comments`. The deeper check in `assertCommentScope` (`lib/meta/scope-check.ts:309-335`, called from `postAccessibilityError` at `app/api/automations/route.ts:305`) still surfaces the issue at activation time if the live probe at that moment returns the same incomplete scope set.

Le 2026-08-31, après le canari négatif, la campagne `TEST`
`cmth1ave3000l07qx8mgpuwxv` a été désactivée et le flag production remis à
`false`. Le 409 `MISSING_COMMENT_SCOPE` est de nouveau la seule réponse correcte
tant que Meta n'a pas accordé la permission.

## Live test (definitive)

See `/tmp/LIVE-TEST-CHECKLIST.md` for the full procedure. TL;DR:

1. Patch is live (`/api/health` 200, webhooks subscribed for the 3 accounts)
2. Create a campaign on `@yoyakurecordstore` with keyword `TESTOPENREPLY`
3. Comment from another IG account
4. Tail `openreply-worker` logs
5. Check DM Logs + the test account's Instagram inbox

- DM arrives → scope is in the token, the probe is the bug. Rewrite the probe to
  sample more widely or use an alternate endpoint.
- DM does not arrive → **observé le 2026-08-31**. Le scope est réellement absent.
  App Review est nécessaire pour `instagram_business_basic` +
  `instagram_business_manage_comments`, puis chaque compte doit être déconnecté
  et reconnecté avant un nouveau canari.
