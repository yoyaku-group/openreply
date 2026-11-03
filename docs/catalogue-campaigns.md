# Future publication campaigns (catalogue hashtags)

OpenReply can hold a comment-to-DM campaign for a release that is not published
yet. The campaign waits for the first feed post or reel published after it was
validated whose caption carries the release catalogue hashtag. Metricool (or
any other publisher) remains the publisher; Calendar remains the planning
owner. OpenReply only attaches and sends the DM.

## English

1. **Create a campaign** in OpenReply, choose `Comment on a post or reel` then
   `A future publication with a catalogue hashtag`.
2. **Enter the catalogue hashtag** printed on the release, for example
   `#ABC001`. The leading `#` is optional and the stored form is upper-case.
   This hashtag identifies the future post. It is **not** the keyword
   commenters type: set that keyword separately (the builder pre-fills `LINK`
   for a new catalogue campaign only).
3. **Add a destination link.** It is required for this scope, even when saving
   a draft.
4. **Save draft** keeps the campaign out of the queue. **Validate for
   publication** arms it. Only validate once the destination, the DM copy and
   the button labels are approved for the week.
5. After validation, no second activation step is needed. When a matching
   publication appears, OpenReply attaches the campaign and starts sending on
   matching comments.

Rules:

- One waiting campaign per catalogue hashtag and Instagram account, drafts
  included. A different catalogue reference can wait alongside it. Once the
  first campaign binds to its publication, a new one may be prepared for a
  later release.
- A draft never sends. A paused campaign stops sending immediately.
- Calendar owns planning. If Calendar already has a campaign for the same
  release, OpenReply refuses a second DM call to action and links you to the
  existing campaign. If a Calendar campaign appears after the manual one was
  armed, the binder parks the manual campaign as **Needs attention** instead of
  creating a duplicate DM.

Status vocabulary:

| Status | Meaning |
|---|---|
| **Draft** | Saved, not approved. It cannot send. |
| **Waiting for #ABC001** | Approved and looking for its publication. |
| **Active** | Attached and sending on matching comments. |
| **Paused** | Stopped, including after a manual pause. |
| **Needs attention** | A conflict or readiness problem requires a human decision. |

Readiness errors:

- `CATALOGUE_BINDING_DISABLED`: the attach binder is off on this deployment.
  Keep the campaign as a draft and ask an operator to enable it; do not claim
  the campaign is live.
- `CATALOGUE_REF_CONFLICT`: another campaign is already waiting for the same
  hashtag and account. Open the linked campaign and pause, delete or let it
  bind before arming another.
- `CALENDAR_CAMPAIGN_CONFLICT`: Calendar already plans this release. Review the
  linked Calendar campaign instead of creating a second DM call to action.
- `INSTAGRAM_CAPABILITY_BLOCKED`: the account cannot read comments or send the
  required DM type. Fix the account permissions and retry. Capability checks
  show readiness; they do not prove that a real DM was sent.

## Français

1. **Créez une campagne** dans OpenReply, choisissez `Commentaire sur une
   publication` puis `Une future publication avec un hashtag catalogue`.
2. **Saisissez le hashtag catalogue** imprimé sur la sortie, par exemple
   `#ABC001`. Le `#` initial est facultatif et la forme stockée est en
   majuscules. Ce hashtag identifie la future publication. Ce n'est **pas** le
   mot-clé que les internautes commentent : renseignez ce mot-clé séparément
   (le formulaire pré-remplit `LINK` uniquement pour une nouvelle campagne
   catalogue).
3. **Ajoutez un lien de destination.** Il est obligatoire pour ce mode, même
   pour un brouillon.
4. **Enregistrer le brouillon** garde la campagne hors de la file. **Valider
   pour publication** l'arme. Ne validez qu'une fois le lien, le message et les
   libellés de boutons approuvés pour la semaine.
5. Après validation, aucune seconde activation n'est nécessaire. Dès qu'une
   publication correspondante apparaît, OpenReply attache la campagne et envoie
   le DM sur les commentaires correspondants.

Règles :

- Une seule campagne en attente par hashtag catalogue et compte Instagram,
  brouillons compris. Une autre référence catalogue peut attendre en parallèle.
  Une fois la première campagne attachée à sa publication, une nouvelle peut
  être préparée pour une sortie ultérieure.
- Un brouillon n'envoie jamais. Une campagne en pause s'arrête immédiatement.
- Calendar reste propriétaire de la planification. Si Calendar a déjà une
  campagne pour la même sortie, OpenReply refuse un second appel à l'action DM
  et renvoie vers la campagne existante. Si une campagne Calendar apparaît
  après l'armement manuel, le binder place la campagne manuelle en **Needs
  attention** au lieu de créer un DM en double.

Statuts :

| Statut | Signification |
|---|---|
| **Draft** | Enregistrée, non approuvée. Elle ne peut pas envoyer. |
| **Waiting for #ABC001** | Approuvée, en attente de sa publication. |
| **Active** | Attachée et envoi sur les commentaires correspondants. |
| **Paused** | Arrêtée, y compris après une pause manuelle. |
| **Needs attention** | Un conflit ou un problème de disponibilité demande une décision humaine. |

Erreurs de disponibilité :

- `CATALOGUE_BINDING_DISABLED` : le binder d'attachement est désactivé sur ce
  déploiement. Gardez la campagne en brouillon et demandez à un opérateur de
  l'activer ; ne déclarez pas la campagne en ligne.
- `CATALOGUE_REF_CONFLICT` : une autre campagne attend déjà le même hashtag et
  le même compte. Ouvrez la campagne liée et mettez-la en pause, supprimez-la,
  ou laissez-la s'attacher avant d'en armer une autre.
- `CALENDAR_CAMPAIGN_CONFLICT` : Calendar planifie déjà cette sortie. Examinez
  la campagne Calendar liée au lieu de créer un second appel à l'action DM.
- `INSTAGRAM_CAPABILITY_BLOCKED` : le compte ne peut pas lire les commentaires
  ou envoyer le type de DM requis. Corrigez les permissions du compte et
  réessayez. Les contrôles de capacité indiquent la disponibilité ; ils ne
  prouvent pas qu'un DM réel a été envoyé.
