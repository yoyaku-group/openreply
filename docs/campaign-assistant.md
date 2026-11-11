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
   `/product/<slug>/`) or a bare SKU (for example `LM-02`). Only URLs on the
   shop host are accepted. The assistant reads the public WooCommerce Store
   API and the public `musicartist`/`musiclabel` taxonomies — no token, no
   admin session. Results are memoized for 5 minutes.
3. **The caption is optional.** A simple product works with no caption at all:
   the DM copy comes from the product description. Paste a caption only for
   special posts (a making-of reel, a narrative post) — the assistant checks
   it and completes it, it never rewrites it.
4. **Review the facts**: SKU, catalogue hashtag, artists, label, state
   (Pre-order / Coming soon / Back in stock / Available), thumbnail. Anything
   the shop could not provide shows as an editable input — fill it in, the
   copy refuses to invent values.
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
   creating a second one.

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
| `PRODUCT_NOT_FOUND` | Prepare | No product matches on the shop. |
| `SHOP_UNAVAILABLE` | Prepare | The shop did not answer; try again. |
| `MISSING_FACTS` | Copy | The shop (or you) has not filled these facts; copy is not generated. |
| `CATALOGUE_REF_CONFLICT` | Save / Validate | Another campaign already waits for the same hashtag and account. |
| `CALENDAR_CAMPAIGN_CONFLICT` | Save / Validate | Calendar already plans this release. |
| `CATALOGUE_BINDING_DISABLED` | Validate | Arming future-publication campaigns is off on this deployment. |
| `INSTAGRAM_CAPABILITY_BLOCKED` | Validate | The account cannot read comments or send the DM type. |

Conflict errors carry a link to the existing campaign.

## Français

1. **Ouvrez l'assistant** depuis la liste des campagnes (**Prepare from a
   product**) ou depuis le bloc hashtag catalogue du builder.
2. **Donnez le produit** : une URL produit (`https://yoyaku.io/release/<slug>/`
   ou `/product/<slug>/`) ou un SKU nu (par exemple `LM-02`). Seules les URLs
   du domaine de la boutique sont acceptées. L'assistant lit l'API publique
   WooCommerce et les taxonomies publiques `musicartist`/`musiclabel` — sans
   token. Les résultats sont memoizés 5 minutes.
3. **La légende est facultative.** Un produit simple fonctionne sans légende :
   le copy du DM vient de la description produit. Collez une légende seulement
   pour les posts spéciaux (un making-of, un post narratif) — l'assistant la
   vérifie et la complète, il ne la réécrit jamais.
4. **Vérifiez les faits** : SKU, hashtag catalogue, artistes, label, état
   (Pre-order / Coming soon / Back in stock / Available), vignette. Tout ce
   que la boutique n'a pas fourni se montre en champ éditable — remplissez-le,
   le copy refuse d'inventer des valeurs.
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
   jour au lieu d'en créer une seconde.

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
| `PRODUCT_NOT_FOUND` | Prepare | Aucun produit correspondant sur la boutique. |
| `SHOP_UNAVAILABLE` | Prepare | La boutique n'a pas répondu ; réessayez. |
| `MISSING_FACTS` | Copy | Ces faits manquent ; le copy n'est pas généré. |
| `CATALOGUE_REF_CONFLICT` | Save / Validate | Une autre campagne attend déjà le même hashtag et compte. |
| `CALENDAR_CAMPAIGN_CONFLICT` | Save / Validate | Calendar planifie déjà cette sortie. |
| `CATALOGUE_BINDING_DISABLED` | Validate | L'armement des campagnes future-publication est désactivé. |
| `INSTAGRAM_CAPABILITY_BLOCKED` | Validate | Le compte ne peut pas lire les commentaires ou envoyer le type de DM. |

Les erreurs de conflit portent un lien vers la campagne existante.
