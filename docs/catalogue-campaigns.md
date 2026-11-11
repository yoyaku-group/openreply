# Future publication campaigns (catalogue hashtags)

Anyone who comments receives the private message. YOYAKU never asks for a
specific word, so a comment campaign matches every comment unless someone
deliberately narrows it to a word.

OpenReply can hold a comment-to-DM campaign for a release that is not published
yet. The campaign waits for the first feed post or reel published after it was
created whose caption carries the release catalogue hashtag. Metricool (or
any other publisher) remains the publisher; Calendar remains the planning
owner. OpenReply only attaches and sends the DM.

## English

1. **Create a campaign** in OpenReply, choose `Comment on a post or reel` then
   `A future publication with a catalogue hashtag`.
2. **Enter the catalogue reference** printed on the release, for example
   `#ABC001`. The leading `#` is optional, separators are accepted and stored
   without them (`LM-02`, `lm 02` and `#LM_02` all store as `LM02`), and a
   reference needs at least one digit. Instagram ends a hashtag at a dash, so
   `LM-02` is published as `#LM02` — the separator-free hashtag is what goes
   in the caption. This reference identifies the future post. It says nothing
   about the comment matcher, which stays on `any word`.
3. **Add a destination link.** It is required for this scope, even when saving
   a draft.
4. **Save draft** keeps the campaign out of the queue. **Validate for
   publication** arms it. Only validate once the destination, the DM copy and
   the button labels are approved for the week.
5. After validation, no second activation step is needed. When a matching
   publication appears, OpenReply attaches the campaign and starts sending on
   every comment.

Rules:

- One waiting campaign per catalogue hashtag and Instagram account, drafts
  included. A different catalogue reference can wait alongside it. Once the
  first campaign binds to its publication, a new one may be prepared for a
  later release.
- References are stored without separators (`LM-02` stores as `LM02`), so the
  caption must carry the stored hashtag `#LM02`. The binder compares whole
  tokens on the normalized reference: `#LM-02`, `#lm02` and `#LM_02` in a
  caption all count as `#LM02`, while `#LM02X` does not. A reference must
  carry at least one digit — `#LM` and `#VINYL` are refused.
- A draft never sends. A paused campaign stops sending immediately. A paused
  Calendar campaign does not reserve the reference and does not park a manual
  campaign.
- Calendar owns planning. If Calendar already has a campaign for the same
  release, OpenReply refuses a second DM call to action and links you to the
  existing campaign. If a Calendar campaign appears after the manual one was
  armed, the binder parks the manual campaign as **Needs attention** instead of
  creating a duplicate DM.
- A Calendar campaign cannot be activated on a post already served by an active
  manual campaign with the same reference. OpenReply refuses the activation and
  links the active campaign. Each comment would otherwise receive two private
  messages, because the duplicate-send guard is per campaign.
- A caption must carry one reference. Two references on one post attach two
  campaigns to that post, and every comment then receives two private
  messages.

Status vocabulary:

| Status | Meaning |
|---|---|
| **Draft** | Saved, not approved. It cannot send. |
| **Waiting for #ABC001** | Approved and looking for its publication. |
| **Active** | Attached and sending on every comment. |
| **Paused** | Stopped, including after a manual pause. |
| **Needs attention** | A conflict or readiness problem requires a human decision. |

Readiness errors:

- `CATALOGUE_BINDING_DISABLED`: the attach binder is off on this deployment.
  Keep the campaign as a draft and ask an operator to enable it; do not claim
  the campaign is live.
- `CATALOGUE_REF_CONFLICT`: another campaign is already waiting for the same
  hashtag and account. Open the linked campaign and change its target, or let
  it attach before preparing another. Pausing keeps the reference reserved.
- `CALENDAR_CAMPAIGN_CONFLICT`: Calendar already plans this release. Review the
  linked Calendar campaign instead of creating a second DM call to action.
- `INSTAGRAM_CAPABILITY_BLOCKED`: the account cannot read comments or send the
  required DM type. Fix the account permissions and retry. Capability checks
  show readiness; they do not prove that a real DM was sent.

## Français

1. **Créez une campagne** dans OpenReply, choisissez `Comment on a post or reel`
   puis `a future publication with a catalogue hashtag` (publication à venir par référence).
2. **Saisissez la référence catalogue** imprimée sur la sortie, par exemple
   `#ABC001`. Le `#` initial est facultatif, les séparateurs sont acceptés et
   stockés sans eux (`LM-02`, `lm 02` et `#LM_02` sont tous stockés `LM02`),
   et une référence doit contenir au moins un chiffre. Instagram coupe un
   hashtag au tiret, donc `LM-02` est publié `#LM02` — c'est le hashtag sans
   séparateur qui va dans la légende. Cette référence identifie la future
   publication. Elle ne change rien au filtre de commentaire, qui reste sur
   `any word`.
3. **Ajoutez un lien de destination.** Il est obligatoire pour ce mode, même
   pour un brouillon.
4. **Save draft** enregistre le brouillon sans autoriser l'envoi. **Validate
   for publication** autorise la réponse après rattachement. Ne validez qu'une fois le lien, le message et les
   libellés de boutons approuvés pour la semaine.
5. Après validation, aucune seconde activation n'est nécessaire. Dès qu'une
   publication correspondante apparaît, OpenReply attache la campagne et envoie
   le DM sur chaque commentaire.

Règles :

- Une seule campagne en attente par hashtag catalogue et compte Instagram,
  brouillons compris. Une autre référence catalogue peut attendre en parallèle.
  Une fois la première campagne attachée à sa publication, une nouvelle peut
  être préparée pour une sortie ultérieure.
- Les références sont stockées sans séparateurs (`LM-02` est stocké `LM02`),
  donc la légende doit porter le hashtag stocké `#LM02`. Le binder compare des
  tokens entiers sur la référence normalisée : `#LM-02`, `#lm02` et `#LM_02`
  dans une légende valent tous `#LM02`, mais `#LM02X` non. Une référence doit
  contenir au moins un chiffre — `#LM` et `#VINYL` sont refusés.
- Un brouillon n'envoie jamais. Une campagne en pause s'arrête immédiatement.
  Une campagne Calendar en pause ne réserve pas la référence et ne bloque pas
  une campagne manuelle.
- Calendar reste propriétaire de la planification. Si Calendar a déjà une
  campagne pour la même sortie, OpenReply refuse un second appel à l'action DM
  et renvoie vers la campagne existante. Si une campagne Calendar apparaît
  après l'armement manuel, le binder place la campagne manuelle en **Needs
  attention** au lieu de créer un DM en double.
- Une campagne Calendar ne peut pas être activée sur une publication déjà
  servie par une campagne manuelle active portant la même référence. OpenReply
  refuse l'activation et renvoie vers la campagne active. Sinon chaque
  commentaire recevrait deux messages privés, car le garde-fou anti-doublon
  s'applique par campagne.
- Une légende doit porter une seule référence. Deux références sur une même
  publication rattachent deux campagnes à cette publication, et chaque
  commentaire reçoit alors deux messages privés.

Statuts :

| Statut | Signification |
|---|---|
| **Draft** | Enregistrée, non approuvée. Elle ne peut pas envoyer. |
| **Waiting for #ABC001** | Approuvée, en attente de sa publication. |
| **Active** | Attachée et envoi sur chaque commentaire. |
| **Paused** | Arrêtée, y compris après une pause manuelle. |
| **Needs attention** | Un conflit ou un problème de disponibilité demande une décision humaine. |

Erreurs de disponibilité :

- `CATALOGUE_BINDING_DISABLED` : le binder d'attachement est désactivé sur ce
  déploiement. Gardez la campagne en brouillon et demandez à un opérateur de
  l'activer ; ne déclarez pas la campagne en ligne.
- `CATALOGUE_REF_CONFLICT` : une autre campagne attend déjà le même hashtag et
  le même compte. Ouvrez la campagne indiquée et changez sa cible, ou attendez
  son rattachement avant d'en préparer une autre. La pause conserve la réservation.
- `CALENDAR_CAMPAIGN_CONFLICT` : Calendar planifie déjà cette sortie. Examinez
  la campagne Calendar liée au lieu de créer un second appel à l'action DM.
- `INSTAGRAM_CAPABILITY_BLOCKED` : le compte ne peut pas lire les commentaires
  ou envoyer le type de DM requis. Corrigez les permissions du compte et
  réessayez. Les contrôles de capacité indiquent la disponibilité ; ils ne
  prouvent pas qu'un DM réel a été envoyé.
