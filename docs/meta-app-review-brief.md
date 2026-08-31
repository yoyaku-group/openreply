# Meta App Review — Step-by-step brief

**Statut** : matériel technique prêt, mais **soumission bloquée** tant qu'un accès
reviewer réutilisable n'est pas fourni et que la Business Verification n'est pas
confirmée. Le magic link `appreview@yoyaku.fr` arrive actuellement dans la boîte
privée de Ben ; demander au reviewer d'ouvrir cette boîte n'est pas une procédure
de test valide.

**App Meta de production** : `4047290928735084` (valeur vérifiée dans le conteneur
OpenReply le 2026-08-31).

**Verdict de diagnostic** : scope `instagram_business_manage_comments` **absent
des 3 tokens**. Le canari réel Objects du 2026-08-31 (`Yes` sur le post
`DOTUhHSjDPY`) n'a produit ni webhook `comments`, ni `DmLog`, tandis que le web,
Redis, la queue et le worker étaient sains. Le mode advisory a ensuite été remis
à `false` et la campagne de test désactivée.

## TL;DR — résumé en 30 secondes

Après résolution des deux prérequis ci-dessus, tu vas soumettre 2 permissions
(PAS 3 — c'était l'erreur n°1 du brouillon original) :

1. **`instagram_business_basic`** — déjà Standard Access, mais à soumettre en Advanced pour permettre à OpenReply d'être utilisée par d'autres comptes
2. **`instagram_business_manage_comments`** — la fameuse. Standard Access suffit SI OpenReply sert uniquement tes propres comptes. Comme tu as 3 comptes distincts (et que c'est une plateforme multi-tenant en devenir), **Advanced Access requis**.

Ce document est le paquet canonique : descriptions des permissions, script vidéo,
instructions reviewer, vérifications et séquence post-approbation. Les fichiers
historiques sous `/tmp/` ne sont pas une source durable et ne doivent pas être
copiés tels quels dans la soumission.

## Étape 0 — pré-requis (~5 min)

1. Ouvre un navigateur privé → https://developers.facebook.com → login en tant que **Benjamin Belaga**
2. Sélectionne l'app **OpenReply** (ID production vérifié : `4047290928735084`)
3. En haut à gauche, vérifie que tu es sur le **bon app** (pas un autre perso). Le nom affiché doit être "OpenReply" ou similaire.
4. Confirme la Business Verification et qu'au moins un compte Instagram de
   démonstration est bien rattaché à l'app comme rôle/testeur avec Standard Access.
   Le screencast doit montrer un flow réellement testable avant la demande
   d'Advanced Access.

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
OpenReply receives a webhook event when someone comments on a post published
by a connected Instagram Professional account. When the comment matches the
trigger configured by the account owner, OpenReply sends ONE initial private
reply via POST /{ig-user-id}/messages with recipient.comment_id — limited to
one initial private reply per campaign and comment, valid up to 7 days after
the comment is created. OpenReply does not surface comment text to anyone
other than the account owner who configured the campaign. Comments that do
not match the configured trigger do not cause an outbound action. OpenReply
uses this permission solely for comment-to-DM automations configured by the
account owner.
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

N'enregistre qu'après avoir validé un compte de démonstration sous Standard
Access. Une vidéo montrant une campagne active mais incapable de recevoir les
commentaires contredirait la demande.

### Logiciel de capture
- macOS : QuickTime Player → Fichier → Nouvel enregistrement d'écran
- Sélectionne la zone de l'écran app OpenReply + Instagram web

### Replay du script
1. **Écran 1** (15s) : connexion avec le compte opérateur de démonstration → dashboard
2. **Écran 2** (25s) : Settings → Instagram → reconnecte le compte de démonstration. Lis les permissions réellement affichées par Meta. Le flow OAuth OpenReply demande `instagram_business_basic`, `instagram_business_manage_messages` et `instagram_business_manage_comments`; la présente App Review ne resoumet que `basic` et `manage_comments`, car `manage_messages` est déjà accordé.
3. **Écran 3** (30s) : Crée une automation sur un post récent de @yoyaku.fr ou @yoyakurecordstore. Keyword = `TEST`. DM template = "Here is your link: https://yoyaku.fr/test". Active.
4. **Écran 4** (20s) : depuis un compte IG tiers, commente `TEST`, puis montre la ligne `SENT` dans DM Logs et le message reçu. Une UI vide n'est pas une preuve fonctionnelle.

### Upload
- YouTube → upload **non-listé** (PAS privé, PAS public — non-listé)
- Titre : `OpenReply — Comment-to-DM automation walkthrough`
- Description : app ID + lien vers openreply.yoyaku.fr

### Récupère l'URL
Format : `https://www.youtube.com/watch?v=XXXXXXXXX`

## Étape 5 — Accès reviewer et Instructions for Developers

**Gate bloquant avant soumission** : fournir un accès de test réutilisable que le
reviewer peut ouvrir sans accès à la boîte privée de Ben. La procédure historique
« entrer `appreview@yoyaku.fr`, puis ouvrir `ben@yoyaku.fr` » est invalide et ne
doit pas être envoyée à Meta.

Une fois ce mécanisme disponible, les instructions doivent être en anglais et
indiquer :

- l'URL exacte de connexion et des credentials réutilisables pendant toute la review ;
- les 3 IG pros préconnectés : `@yoyaku.fr`, `@yoyakurecordstore`, `@objects.press` ;
- le chemin Campaigns → exact post → exact keyword → private reply ;
- la route webhook réelle : `POST /api/webhook` ;
- que le reviewer utilise son propre compte IG test pour le commentaire, sans
  partager ses credentials Instagram avec YOYAKU.

## Étape 6 — soumettre (geste Ben)

Pour chaque scope, vérifie que tous les champs sont remplis, que la vidéo est
référencée et que l'accès reviewer a été testé depuis une navigation privée hors
session YOYAKU. Le clic **Submit** est le geste externe explicite de Ben.

Meta t'envoie un email de confirmation "Your app review request has been received". Garde-le.

## Étape 7 — pendant les 5-10 jours d'attente

- **NE PAS déconnecter** les 3 IG pros (sinon webhook subscription saute)
- Le bypass `OPENREPLY_COMMENTS_SCOPE_ADVISORY` reste à `false` : aucune campagne
  COMMENT ne doit pouvoir être activée tant que le scope manque.
- Tu peux utiliser OpenReply normalement pour les automations qui n'ont pas besoin du scope comments (DM-only)

## Étape 8 — après approbation Meta

1. Reçois email "Your app has been approved for these permissions"
2. Va sur OpenReply → Settings → Instagram → **Disconnect + reconnect chaque compte** (`@yoyaku.fr`, `@yoyakurecordstore`, `@objects.press`)
3. Le probe (forcé via `probeAccountScopes(accountId, { workspaceId, forceRefresh: true })`) va re-tester et capturer `instagram_business_manage_comments` dans la colonne `scopes`
4. La bannière rouge disparaît dans Campaign Editor
5. **MB059 peut lancer**
6. Confirme que `OPENREPLY_COMMENTS_SCOPE_ADVISORY=false` reste appliqué. Le bypass
   n'est jamais un état de production valide : il autorise une campagne qui ne peut
   pas recevoir les commentaires.

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
| 3 | "POST `/{media-id}/comments`" pour envoyer le DM | Private reply : `POST /{ig-user-id}/messages` avec `recipient.comment_id`; public nested reply optionnelle : `POST /{comment-id}/replies` |
| 4 | "No reading of comments that don't match" | Formulation honnête : "OpenReply reçoit le webhook, ne déclenche QUE si keyword match" |
| 5 | Implicite "Standard Access suffit" | Advanced Access requis (multi-tenant SaaS) |

## Sources durables

- `docs/instagram-scope-probe.md` — diagnostic, faux négatifs connus et verdict live
- `lib/meta/oauth.ts` — liste exacte des scopes demandés par OAuth
- `app/api/webhook/route.ts` — endpoint webhook et validation HMAC
- `lib/queue/dm-worker.ts` — déduplication, matching et private reply

## Mission close — pas de soumission Meta effectuée

Cette mission autopilot a fait UNIQUEMENT :
- ✅ Diagnostic via probe multi-signal (15 échantillons, 3 comptes, verdict : scope absent)
- ✅ Canary humain `@objects.press` du 2026-08-31 : aucun webhook commentaire,
  aucun `DmLog`, infrastructure saine — verdict confirmé
- ✅ Campagne `cmth1ave3000l07qx8mgpuwxv` désactivée et garde-fou strict restauré
- ✅ Rédaction du brief step-by-step (ce document)
- ❌ Accès reviewer réutilisable encore à concevoir/valider
- ❌ PAS soumis App Review (geste Ben, target-named)

Pour avancer : suis ce brief à partir de l'Étape 0 quand tu es de retour.
