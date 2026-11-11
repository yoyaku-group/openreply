# Campaign assistant (product → ready campaign)

Anyone who comments receives the private message. YOYAKU never asks for a
specific word, so a comment campaign matches every comment unless someone
deliberately narrows it to a word.

The campaign assistant is one screen: give a product (a yoyaku.io URL or a
SKU), optionally paste the post caption, review, validate. It resolves the
product from the shop's public data, generates the DM copy, checks the
caption, and hands the finished campaign to the normal campaign API. It never
writes a campaign by itself — **Save draft** and **Validate for publication**
call the same `POST`/`PATCH /api/automations` the builder uses.

## English

1. **Open the assistant** from the campaigns list (**Prepare from a product**)
   or from the builder's catalogue-hashtag block.
2. **Give the product**: a product URL (`https://yoyaku.io/release/<slug>/` or
   `/product/<slug>/`; the `www.` variant of the shop host is accepted too) or
   a bare SKU. The Store API matches the SKU **exactly as printed on the
   shop, separators included** — `LM-02` matches, `LM02` does not. Only URLs
   on the shop host are accepted. The assistant reads the public WooCommerce
   Store API and the public `musicartist`/`musiclabel` taxonomies — no token,
   no admin session. Results are memoized for 5 minutes.
3. **The caption is optional.** A simple product works with no caption at all:
   the DM copy comes from the product description. Paste a caption only for
   special posts (a making-of reel, a narrative post) — the assistant checks
   it and completes it, it never rewrites it.
4. **Review the facts**: SKU, catalogue hashtag, artists, label, state
   (Pre-order / Coming soon / Sold out / Back in stock / Available),
   thumbnail. Anything the shop could not provide shows as an editable input —
   fill it in, the copy refuses to invent values. A **Coming soon** or
   **Sold out** product cannot be bought yet: the assistant produces drafts
   only, "Validate for publication" is refused ("This product cannot be
   bought yet: save as draft"), and the copy for those states never claims
   availability.
5. **Review the copy**: opening DM and button (two-step DM, on by default),
   link DM and link button, each editable with the Meta counters. Copy is
   marked **Standard copy** — it is poured into the hand-written YOYAKU shells
   (`buildCampaignCopy`) and linted by the copy linter. The campaign name is
   generated as `<SKU> · <Title>` so the list stays readable.
6. **Choose when**:
   - **Next post with #LM02** (default): the campaign waits for the first
     publication whose caption carries the hashtag (`pendingNextReel`,
     `catnoTag`).
   - **Post already published**: pick the post or reel; the campaign binds to
     it directly (`postId`, `postUrl`). This is the shape of the hand-made
     LM-02 campaign of 2026-11-09.
7. **Finish**: **Copy final caption** copies the completed caption (or just
   the lines to add when no caption was pasted), **Save draft** keeps the
   campaign out of the queue, **Validate for publication** arms it. If a
   campaign already exists for the same reference on the account, the
   assistant links it and **Complete this campaign** updates it instead of
   creating a second one. Completing a **Calendar** campaign updates the copy
   fields only — the publication and the destination stay Calendar-owned, and
   the campaign keeps waiting for its Calendar-planned publication (arming
   happens through Calendar's own Meta-proof path).

### Sources

- **Product description by default**: `short_description`, falling back to
  `description`, stripped of HTML and entities, capped at 1200 characters.
- **Caption optional**: only enriches special posts. The assistant appends
  whole lines (CTA, hashtag); it never edits the pasted sentences.

### The hashtag rule

Catalogue references are stored without separators: the SKU `LM-02` stores as
`LM02` and is published as **`#LM02`**. Instagram ends a hashtag at a dash, so
the separator-free form is the one that goes in the caption and the one the
attach binder compares. A reference needs at least one digit — a SKU like
`TEESHIRT` shows as a missing fact, and the catalogue scope refuses until it
is fixed or the campaign binds to a published post.

### The checks

| Check | Level | Meaning |
|---|---|---|
| `REFERENCE_PRESENT` | ok | The caption carries the product reference. |
| `REFERENCE_MISSING` | warn | The hashtag is added below the caption. |
| `OTHER_REFERENCE` | error | The caption carries another reference. Two references send two messages. |
| `REFERENCE_UNRESOLVED` | warn | The SKU is not a catalogue reference, so the caption's references cannot be matched. |
| `CTA_PRESENT` / `CTA_MISSING` | ok / warn | The call to action per state (`Comment to pre-order!` for a pre-order, otherwise `Comment to get the link!`). |
| `PRICE_IN_CAPTION` | warn | A price in the caption (prices change; the DM carries the link). |
| `URL_IN_CAPTION` | warn | A URL in the caption (the DM link is tracked, a caption link is not). |
| `TOO_MANY_HASHTAGS` | warn | More than 5 hashtags. |
| `CAPTION_TOO_LONG` | warn | More than 2,200 characters. |

The copy linter (`lib/copy/copy-linter.ts`) runs on the DM copy: facts only,
no emoji, no dashes, no invented names, Meta limits (body 640, button 20).

### Error codes

| Code | Where | Meaning |
|---|---|---|
| `PRODUCT_URL_INVALID` | Prepare | Not a shop URL or a usable SKU. |
| `PRODUCT_NOT_FOUND` | Prepare | No product matches on the shop. Type the SKU exactly as printed (separators included) or paste the product URL. |
| `SHOP_UNAVAILABLE` | Prepare | The shop did not answer; try again. |
| `MISSING_FACTS` | Copy | The shop (or you) has not filled these facts; copy is not generated. |
| `CATALOGUE_REF_CONFLICT` | Save / Validate | Another campaign already waits for the same hashtag and account. |
| `CALENDAR_CAMPAIGN_CONFLICT` | Save / Validate | Calendar already plans this release. |
| `CATALOGUE_BINDING_DISABLED` | Validate | Arming future-publication campaigns is off on this deployment. |
| `INSTAGRAM_CAPABILITY_BLOCKED` | Validate | The account cannot read comments or send the DM type. |

Conflict errors carry a link to the existing campaign.

### AI copy

While you review the standard copy, an AI copywriter works on a better
version in the background. It never blocks anything: every failure keeps the
standard copy.

**The flow.** Preparing a buyable product (`Pre-order`, `Back in stock`,
`Available`) queues one generation. The screen shows the standard copy at
once with a **Writing a better version…** badge, and polls the generation
status every 1.5 s for up to 25 s. When the AI version arrives and you have
not edited the texts yet, it replaces them in the fields with the badge
**AI · v{n}**. If you already edited, the badge reads **AI version ready**
with a **Use it** button — nothing is overwritten. On failure or after 25 s
the badge falls back to **Standard copy**. **Regenerate AI copy** re-prepares
the product and queues a new generation.

**The sources.** The product description is the main source; the caption is
optional and only suggests a hook for the reveal DM. The description and the
caption are each truncated to 1,200 characters.

**The guard chain.** The model answers one JSON object
(`openingDm`, `openingButton`, `revealDm`, `linkButton`) against a strict
schema. The app then validates:

1. zod: the four strings exist and respect the prompt limits (opening 160,
   reveal 280, buttons 20 characters);
2. the YOYAKU linter with one relaxation: a proper noun that appears verbatim
   in the description or the caption is allowed ("Discogs" in the LM-02
   caption) — prices, emoji, dashes, AI mentions, URLs and length limits stay
   forbidden whatever the source;
3. on any error, exactly one repair attempt is queued, its prompt carrying
   the linter messages and the previous answer;
4. a second failure marks the generation FAILED and the standard copy stays.

**Kill switches.** `COPYWRITER_ENABLED=false` in the app environment stops
new generations (default). `systemctl stop openreply-copywriter` stops the
host worker from draining the queue. Both leave every campaign on its
standard copy.

**What is stored.** Each generation stores the product facts and the
truncated caption (public shop data only — never tokens or personal data),
the rendered prompt, the raw answer, the lint result and the standard copy it
falls back to. On save from the assistant, the copy you validated is stored
as `finalCopy` with its `editDistance` from the model output and the campaign
it landed on. Rows are purged after 90 days by the `purge-copywriter` cron
route. The prompt itself is versioned per workspace: v1 is seeded from
`lib/assistant/prompts/caption-to-dm.v1.md` on first use, a new version is a
new row, and the rendered prompt travels with the generation — editing the
prompt never needs a worker deploy.

**Release sync.** The inactive campaigns created by the release sync get an
AI copy generation too. When it passes the guard chain, the copy is applied
to that campaign only if it is still inactive and nobody edited its four
copy fields; `appliedAt` records the swap. The campaign is never activated by
the AI — activation stays human (playbook).

## Français

1. **Ouvrez l'assistant** depuis la liste des campagnes (**Prepare from a
   product**) ou depuis le bloc hashtag catalogue du builder.
2. **Donnez le produit** : une URL produit (`https://yoyaku.io/release/<slug>/`
   ou `/product/<slug>/` ; la variante `www.` du domaine de la boutique est
   acceptée aussi) ou un SKU nu. L'API Store compare le SKU **exactement tel
   qu'imprimé sur la boutique, séparateurs compris** — `LM-02` correspond,
   `LM02` non. Seules les URLs du domaine de la boutique sont acceptées.
   L'assistant lit l'API publique WooCommerce et les taxonomies publiques
   `musicartist`/`musiclabel` — sans token. Les résultats sont memoizés
   5 minutes.
3. **La légende est facultative.** Un produit simple fonctionne sans légende :
   le copy du DM vient de la description produit. Collez une légende seulement
   pour les posts spéciaux (un making-of, un post narratif) — l'assistant la
   vérifie et la complète, il ne la réécrit jamais.
4. **Vérifiez les faits** : SKU, hashtag catalogue, artistes, label, état
   (Pre-order / Coming soon / Sold out / Back in stock / Available), vignette.
   Tout ce que la boutique n'a pas fourni se montre en champ éditable —
   remplissez-le, le copy refuse d'inventer des valeurs. Un produit **Coming
   soon** ou **Sold out** ne s'achète pas encore : l'assistant ne produit que
   des brouillons, "Validate for publication" est refusé (« This product
   cannot be bought yet: save as draft »), et le copy de ces états ne
   prétend jamais une disponibilité.
5. **Vérifiez le copy** : DM d'ouverture et bouton (DM en deux temps, activé
   par défaut), DM du lien et bouton du lien, chacun éditable avec les
   compteurs Meta. Le copy est marqué **Standard copy** — il est versé dans
   les shells YOYAKU écrits à la main (`buildCampaignCopy`) et passé au
   linter. Le nom de campagne est généré en `<SKU> · <Titre>` pour que la
   liste reste lisible.
6. **Choisissez quand** :
   - **Next post with #LM02** (défaut) : la campagne attend la première
     publication dont la légende porte le hashtag (`pendingNextReel`,
     `catnoTag`).
   - **Post already published** : choisissez le post ou reel ; la campagne se
     lie directement (`postId`, `postUrl`). C'est la forme de la campagne
     LM-02 faite à la main le 2026-11-09.
7. **Terminez** : **Copy final caption** copie la légende complétée (ou
   seulement les lignes à ajouter quand aucune légende n'a été collée),
   **Save draft** garde la campagne hors de la file, **Validate for
   publication** l'arme. Si une campagne existe déjà pour la même référence
   sur le compte, l'assistant la lie et **Complete this campaign** la met à
   jour au lieu d'en créer une seconde. Compléter une campagne **Calendar**
   ne met à jour que les champs de copy — la publication et la destination
   restent la propriété de Calendar, et la campagne continue d'attendre sa
   publication planifiée (l'armement passe par le chemin de preuve Meta de
   Calendar).

### Sources

- **Description produit par défaut** : `short_description`, à défaut
  `description`, nettoyée du HTML et des entités, plafonnée à 1200 caractères.
- **Légende facultative** : elle n'enrichit que les posts spéciaux.
  L'assistant ajoute des lignes entières (CTA, hashtag) ; il ne touche pas aux
  phrases collées.

### La règle du hashtag

Les références catalogue sont stockées sans séparateurs : le SKU `LM-02` est
stocké `LM02` et publié **`#LM02`**. Instagram coupe un hashtag au tiret, donc
c'est la forme sans séparateur qui va dans la légende et que compare le
binder. Une référence doit porter au moins un chiffre — un SKU comme
`TEESHIRT` s'affiche comme fait manquant, et le mode catalogue refuse tant que
ce n'est pas corrigé ou que la campagne n'est pas liée à un post publié.

### Les contrôles

| Contrôle | Niveau | Signification |
|---|---|---|
| `REFERENCE_PRESENT` | ok | La légende porte la référence du produit. |
| `REFERENCE_MISSING` | warn | Le hashtag est ajouté sous la légende. |
| `OTHER_REFERENCE` | error | La légende porte une autre référence. Deux références envoient deux messages. |
| `REFERENCE_UNRESOLVED` | warn | Le SKU n'est pas une référence catalogue ; les références de la légende ne peuvent pas être comparées. |
| `CTA_PRESENT` / `CTA_MISSING` | ok / warn | L'appel à l'action selon l'état (`Comment to pre-order!` pour un précommande, sinon `Comment to get the link!`). |
| `PRICE_IN_CAPTION` | warn | Un prix dans la légende (les prix changent ; le DM porte le lien). |
| `URL_IN_CAPTION` | warn | Une URL dans la légende (le lien du DM est tracké, pas celui d'une légende). |
| `TOO_MANY_HASHTAGS` | warn | Plus de 5 hashtags. |
| `CAPTION_TOO_LONG` | warn | Plus de 2200 caractères. |

Le linter de copy (`lib/copy/copy-linter.ts`) passe sur le copy des DM :
faits uniquement, pas d'emoji, pas de tirets, pas de nom inventé, limites Meta
(corps 640, bouton 20).

### Codes d'erreur

| Code | Où | Signification |
|---|---|---|
| `PRODUCT_URL_INVALID` | Prepare | Ni URL boutique ni SKU exploitable. |
| `PRODUCT_NOT_FOUND` | Prepare | Aucun produit correspondant sur la boutique. Tapez le SKU exactement tel qu'imprimé (séparateurs compris) ou collez l'URL produit. |
| `SHOP_UNAVAILABLE` | Prepare | La boutique n'a pas répondu ; réessayez. |
| `MISSING_FACTS` | Copy | Ces faits manquent ; le copy n'est pas généré. |
| `CATALOGUE_REF_CONFLICT` | Save / Validate | Une autre campagne attend déjà le même hashtag et compte. |
| `CALENDAR_CAMPAIGN_CONFLICT` | Save / Validate | Calendar planifie déjà cette sortie. |
| `CATALOGUE_BINDING_DISABLED` | Validate | L'armement des campagnes future-publication est désactivé. |
| `INSTAGRAM_CAPABILITY_BLOCKED` | Validate | Le compte ne peut pas lire les commentaires ou envoyer le type de DM. |

Les erreurs de conflit portent un lien vers la campagne existante.

### Le copy IA

Pendant que vous révisez le copy standard, un rédacteur IA travaille en
arrière-plan sur une meilleure version. Il ne bloque jamais rien : chaque
échec garde le copy standard.

**Le flux.** Préparer un produit achetable (`Pre-order`, `Back in stock`,
`Available`) met une génération en file. L'écran affiche le copy standard
immédiatement avec le badge **Writing a better version…**, et interroge le
statut toutes les 1,5 s pendant 25 s maximum. Quand la version IA arrive et
que vous n'avez rien édité, elle remplace les textes avec le badge
**AI · v{n}**. Si vous avez déjà édité, le badge affiche **AI version ready**
avec un bouton **Use it** — rien n'est écrasé. En cas d'échec ou après 25 s,
le badge revient à **Standard copy**. **Regenerate AI copy** relance la
préparation et remet une génération en file.

**Les sources.** La description produit est la source principale ; la légende
est facultative et ne fait que suggérer un hook pour le DM du lien.
Description et légende sont chacune tronquées à 1 200 caractères.

**La chaîne de garde.** Le modèle répond un objet JSON (`openingDm`,
`openingButton`, `revealDm`, `linkButton`) contre un schéma strict.
L'application valide ensuite :

1. zod : les quatre chaînes existent et respectent les limites du prompt
   (ouverture 160, révélation 280, boutons 20 caractères) ;
2. le linter YOYAKU avec un seul assouplissement : un nom propre présent
   tel quel dans la description ou la légende est accepté (« Discogs » dans
   la légende de la LM-02) — prix, emoji, tirets, mentions d'IA, URLs et
   limites de longueur restent interdits quelle que soit la source ;
3. sur toute erreur, exactement une tentative de réparation est remise en
   file, son prompt portant les messages du linter et la réponse précédente ;
4. un second échec marque la génération FAILED et le copy standard reste.

**Kill switches.** `COPYWRITER_ENABLED=false` dans l'environnement de
l'application arrête les nouvelles générations (défaut).
`systemctl stop openreply-copywriter` arrête le worker hôte qui draine la
file. Les deux laissent chaque campagne sur son copy standard.

**Ce qui est stocké.** Chaque génération stocke les faits produit et la
légende tronquée (données publiques de la boutique seulement — jamais de
token ni de donnée personnelle), le prompt rendu, la réponse brute, le
résultat du linter et le copy standard de repli. À la sauvegarde depuis
l'assistant, le copy que vous avez validé est stocké en `finalCopy` avec sa
distance d'édition (`editDistance`) d'avec la sortie du modèle et la campagne
où il a atterri. Les lignes sont purgées après 90 jours par la route cron
`purge-copywriter`. Le prompt lui-même est versionné par workspace : la v1
est semée depuis `lib/assistant/prompts/caption-to-dm.v1.md` au premier
usage, une nouvelle version est une nouvelle ligne, et le prompt rendu voyage
avec la génération — modifier le prompt ne demande jamais de redéploiement du
worker.

**Synchronisation des sorties.** Les campagnes inactives créées par la
synchronisation des sorties reçoivent aussi une génération IA. Quand elle
passe la chaîne de garde, le copy est appliqué à cette campagne seulement si
elle est toujours inactive et si personne n'a modifié ses quatre champs de
copy ; `appliedAt` enregistre l'échange. L'IA n'active jamais une campagne —
l'activation reste humaine (playbook).
