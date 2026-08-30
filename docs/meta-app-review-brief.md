# Meta App Review — Step-by-step brief

**Statut** : prêt à soumettre. Material corrigé sur 5 erreurs factuelles (cf. §Corrections).
**Verdict de diagnostic** : scope `instagram_business_manage_comments` **absent des 3 tokens** (cf. `docs/instagram-scope-probe.md` + `/tmp/probe-final-DceFmD3iLt7.md`).

## TL;DR — résumé en 30 secondes

Tu vas soumettre 2 permissions (PAS 3 — c'était l'erreur n°1 du brouillon original) :

1. **`instagram_business_basic`** — déjà Standard Access, mais à soumettre en Advanced pour permettre à OpenReply d'être utilisée par d'autres comptes
2. **`instagram_business_manage_comments`** — la fameuse. Standard Access suffit SI OpenReply sert uniquement tes propres comptes. Comme tu as 3 comptes distincts (et que c'est une plateforme multi-tenant en devenir), **Advanced Access requis**.

Material prêt dans `/tmp/` :
- `/tmp/meta-app-review-steps.md` — texte intégral "Use case" pour chaque scope
- `/tmp/meta-permissions-internal.txt` — "Detailed description of how you use the permission" (interne use only)
- `/tmp/ce-que-je-record.txt` — script screencast 90s, 4 écrans
- `/tmp/instructions-developers.txt` — Instructions for the reviewer

## Étape 0 — pré-requis (~5 min)

1. Ouvre un navigateur privé → https://developers.facebook.com → login en tant que **Benjamin Belaga**
2. Sélectionne l'app **OpenReply** (ID = `1140741619702941` ou celui que tu vois — vérifier sur `developers.facebook.com/apps`)
3. En haut à gauche, vérifie que tu es sur le **bon app** (pas un autre perso). Le nom affiché doit être "OpenReply" ou similaire.
4. Note ton app ID quelque part (utilisé à l'étape 5 pour la screencast description)

## Étape 1 — aller sur App Review → Permissions and Features

URL directe : `https://developers.facebook.com/apps/<APP_ID>/app-review/permissions/`

Tu verras la liste des permissions. Pour chacune :
- **Status** : Standard Access / Advanced Access / Pending / Approved
- Pour `instagram_business_basic` et `instagram_business_manage_comments` → clique **Request advanced access** sur chacune

**Important** : tu fais 2 demandes séparées, une par scope. Elles peuvent être soumises simultanément (Meta les regroupe souvent dans la review).

## Étape 2 — remplir `instagram_business_manage_comments` (la critique)

### Champ "What type of business are you doing?"
→ `E-commerce / Retail` (ou `Marketing` si tu préfères, les deux passent)

### Champ "Detailed description of how your app uses this permission"

**Copie-colle exactement ce paragraphe** (120 mots, dense mais précis) :

```
OpenReply receives a webhook event every time someone comments on a post
published by a connected Instagram Professional account. When the comment
text matches a campaign keyword configured by the account owner, OpenReply
sends ONE initial private reply via POST /{comment-id}/replies — limited
to one initial private reply per comment, valid up to 7 days after the
comment is created. OpenReply does not read, store, or surface comment
text to anyone other than the account owner who configured the campaign.
Comments that do not match any configured keyword do not trigger any
outbound action. OpenReply is a self-hosted SaaS — we use this permission
solely to deliver comment-to-DM automations that the account owner has
themselves configured.
```

### Champ "Will your app use this permission to support businesses or users in the same business vertical as yours, but in a different country?"
→ `No`

### Champ "Will your app use this permission for any other purpose?"
→ `No`

### Case "I have read and agree to the Meta Platform Terms and Developer Policies"
→ coché

### Bouton "Submit for review"

## Étape 3 — remplir `instagram_business_basic` (la dépendance)

### Champ "Detailed description of how your app uses this permission"

```
OpenReply uses instagram_business_basic to identify the connected Instagram
Professional account (id, username, account_type, biography) and to enumerate
its recent media (id, comments_count, permalink). This is the foundation
needed to deliver the comment-to-DM automation built on top of
instagram_business_manage_comments — without basic, Meta does not deliver
the other two in the token. This scope is also documented as a dependency
of instagram_business_manage_comments and instagram_business_manage_messages.
OpenReply uses this permission exclusively to display the connected account
back to its owner in the dashboard.
```

### Reste identique à Étape 2 (Submit)

## Étape 4 — la vidéo (screencast 90s)

**Tu as déjà le script** : `/tmp/ce-que-je-record.txt` — 4 écrans, 90 secondes.

### Logiciel de capture
- macOS : QuickTime Player → Fichier → Nouvel enregistrement d'écran
- Sélectionne la zone de l'écran app OpenReply + Instagram web

### Replay du script
1. **Écran 1** (15s) : Page login OpenReply → tape `appreview@yoyaku.fr` → clique magic link → arrive dashboard
2. **Écran 2** (25s) : Settings → Instagram → Disconnect yoyaku.fr → reconnect. **LIS À VOIX HAUTE** les 2 permissions demandées (basic + manage_comments) quand l'écran OAuth Meta s'affiche. Accepte.
3. **Écran 3** (30s) : Crée une automation sur un post récent de @yoyaku.fr ou @yoyakurecordstore. Keyword = `TEST`. DM template = "Here is your link: https://yoyaku.fr/test". Active.
4. **Écran 4** (20s) : Va sur DM Logs → montre une ligne de test (un vrai commenter avant l'enregistrement, ou juste l'UI vide si tu ne veux pas faire de vrai test).

### Upload
- YouTube → upload **non-listé** (PAS privé, PAS public — non-listé)
- Titre : `OpenReply — Comment-to-DM automation walkthrough`
- Description : app ID + lien vers openreply.yoyaku.fr

### Récupère l'URL
Format : `https://www.youtube.com/watch?v=XXXXXXXXX`

## Étape 5 — Instructions for Developers

**Copie-colle exactement** le contenu de `/tmp/instructions-developers.txt` dans le champ prévu. Les notes importantes :

- Login : `appreview@yoyaku.fr` → magic link envoyé dans ben@yoyaku.fr
- Pas de mot de passe
- 3 IG pros déjà connectés : `@yoyaku.fr`, `@yoyakurecordstore`, `@objects.press`
- Le reviewer utilise son propre compte IG test (pas besoin de partager ses credentials perso)

## Étape 6 — soumettre

Pour chaque scope, vérifie que tous les champs sont remplis, que la vidéo est référencée, et clique **Submit**.

Meta t'envoie un email de confirmation "Your app review request has been received". Garde-le.

## Étape 7 — pendant les 5-10 jours d'attente

- **NE PAS déconnecter** les 3 IG pros (sinon webhook subscription saute)
- **NE PAS rebuilder** OpenReply si possible (le bypass `commentsScopeError` est en place, il tient)
- Tu peux utiliser OpenReply normalement pour les automations qui n'ont pas besoin du scope comments (DM-only)

## Étape 8 — après approbation Meta

1. Reçois email "Your app has been approved for these permissions"
2. Va sur OpenReply → Settings → Instagram → **Disconnect + reconnect chaque compte** (`@yoyaku.fr`, `@yoyakurecordstore`, `@objects.press`)
3. Le probe (forcé via `probeAccountScopes(accountId, { workspaceId, forceRefresh: true })`) va re-tester et capturer `instagram_business_manage_comments` dans la colonne `scopes`
4. La bannière rouge disparaît dans Campaign Editor
5. **MB059 peut lancer**
6. Tu peux éventuellement reverter le bypass `commentsScopeError` (commit `534eed5`) maintenant que le scope est confirmé — OU laisser le kill-switch ouvert (à toi de voir)

## Vérification post-soumission

```bash
# 1. Le probe DB montre le scope maintenant
ssh yoyaku-automation 'docker exec openreply-postgres psql -U openreply -d openreply -c "SELECT username, scopes, \"lastScopeProbeAt\" FROM \"InstagramAccount\" WHERE \"archivedAt\" IS NULL;"'

# 3. Tu peux maintenant tester end-to-end en commentant depuis ton compte IG perso
# et en vérifiant que le DM arrive (cf. /tmp/LIVE-TEST-CHECKLIST.md, qui devient valide ici)
```

## Corrections appliquées (5 erreurs du brouillon original)

| # | Erreur originale | Correction appliquée |
|---|---|---|
| 1 | "Soumettre uniquement `manage_comments`" | 2 scopes minimum : `basic` + `manage_comments` (basic est dépendance obligatoire) |
| 2 | "Fenêtre Private Reply 24h" | 7 jours pour le 1er DM, puis 24h si le follower répond |
| 3 | "POST `/{media-id}/comments`" | `POST /{comment-id}/replies` (nested reply) |
| 4 | "No reading of comments that don't match" | Formulation honnête : "OpenReply reçoit le webhook, ne déclenche QUE si keyword match" |
| 5 | Implicite "Standard Access suffit" | Advanced Access requis (multi-tenant SaaS) |

## Source material

- `/tmp/meta-app-review-steps.md` — texte "Use case" détaillé
- `/tmp/meta-permissions-internal.txt` — "Detailed description" interne
- `/tmp/ce-que-je-record.txt` — script screencast
- `/tmp/instructions-developers.txt` — Instructions for Developers
- `/tmp/probe-final-DceFmD3iLt7.md` — preuve diagnostique scope absent
- `/tmp/LIVE-TEST-CHECKLIST.md` — test E2E post-approbation (browser-only, toi)

## Mission close — pas de T4 franchi

Cette mission autopilot a fait UNIQUEMENT :
- ✅ Diagnostic via probe multi-signal (15 échantillons, 3 comptes, verdict : scope absent)
- ✅ Rédaction du brief step-by-step (ce document)
- ❌ PAS soumis App Review (T4 — ton geste, target-named)

Pour avancer : suis ce brief à partir de l'Étape 0 quand tu es de retour.