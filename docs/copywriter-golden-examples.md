# Copywriter golden examples

The prompt lab (see `docs/campaign-assistant.md`, section "Prompt lab") stores
at most 3 golden examples per prompt version. They are rendered into the
`{{examples}}` placeholder as `FACTS {json} → OUTPUT {json}` blocks and teach
the model the house style with copies the team actually validated.

This file holds the hand-written seed example, ready to be added from the lab
page ("Make it an example" on a matching generation, or the campaign search)
once deployed. It is deliberately DATA, not code: nothing inserts it by
migration — the example only becomes a prompt version through the lab, so the
version history and its metrics stay truthful.

## Example 1 — LM-02 restock (written by hand by the owner)

Source release: Likemind 02 — Nuron & Fugue, Blueprint ARchives (1994 UK split
release reissue).

**Input facts**

- SKU: LM-02
- Title: Likemind 02
- Artists: Nuron & Fugue
- Label: Blueprint ARchives
- State: restock
- Description: "Blueprint ARchives presents a reissue of Likemind 02, the 1994
  UK split release by Nuron and Fugue. …"
- Caption hook: "Fighting the Discogs Sharks"

**Validated copy** (what the team kept after editing the AI output)

- Link DM: "Fighting the Discogs Sharks; Blueprint ARchives presents a reissue
  of Likemind 02"
- Link button: "Grab your copy now!"
- One-step DM (no opening step): opening DM and opening button empty.

**Block as stored on the prompt version**

```
FACTS {"sku":"LM-02","title":"Likemind 02","artists":["Nuron & Fugue"],"label":"Blueprint ARchives","state":"restock"} → OUTPUT {"openingDm":null,"openingButton":null,"revealDm":"Fighting the Discogs Sharks; Blueprint ARchives presents a reissue of Likemind 02","linkButton":"Grab your copy now!"}
```

Why it is golden: it keeps the caption hook as the reveal-DM opener, states
only the restock fact, names label and title without inventing anything, and
uses a direct button label — the exact shape the linter and the house shells
reward.
