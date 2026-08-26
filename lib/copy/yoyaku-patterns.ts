/**
 * YOYAKU voice — hand-written DM patterns.
 *
 * Doctrine (rules/01 §Human-facing Writing + manychat-bible): say what
 * happens, who does what, what is expected, then stop. Real facts poured
 * into short shells. No emoji, ever. No em/en dashes. No rhetorical hooks,
 * no adjective triads, no invented names. The linter in ./copy-linter.ts
 * enforces all of this at generation time.
 *
 * Meta hard limits encoded here (lib/meta/client.ts): button-template body
 * 640 chars, button title 20 chars (silently truncated beyond), 3 buttons.
 */

import type { CampaignFacts, InstoreFacts, ReleaseFacts } from "./release-facts";

export const META_BODY_LIMIT = 640;
export const META_BUTTON_LIMIT = 20;

export interface CampaignCopy {
  /** Campaign name shown in the OpenReply UI. */
  name: string;
  goal: string;
  openingDmMessage: string;
  openingDmButtonLabel: string;
  /** The reveal DM that carries the link button(s). */
  dmMessage: string;
  /** Label of the primary link button (≤20 chars). */
  linkButtonLabel: string;
  trackedDestinationUrl: string;
  secondaryDestinationUrl?: string;
  secondaryButtonLabel?: string;
}

/**
 * Deterministic variant pick: the same release always renders the same copy,
 * so re-running the sync is idempotent and reviewable. Date.now()/random are
 * deliberately absent.
 */
function pickVariant<T>(variants: readonly T[], seed: string): T {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return variants[hash % variants.length];
}

/** "Preorder ABC123" when it fits Meta's 20-char button, plain catno otherwise. */
function preorderButtonLabel(catno: string): string {
  const labeled = `Preorder ${catno}`;
  if (labeled.length <= META_BUTTON_LIMIT) return labeled;
  return catno.slice(0, META_BUTTON_LIMIT);
}

const OPENING_BUTTON_VARIANTS = ["Send the link", "Get the link"] as const;

const REVEAL_VARIANTS = ["Here you go:", "There you go:"] as const;

type ReleaseShell = (facts: ReleaseFacts) => string;

function asSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

interface ReleaseVariant {
  /** Whether the shell interpolates `facts.label` — see `hasUsableLabel`. */
  usesLabel: boolean;
  render: ReleaseShell;
}

/**
 * Every event type MUST keep at least one label-free variant: a release whose
 * label is a placeholder falls back to that subset (asserted by the tests).
 */
const RELEASE_OPENINGS: Record<
  ReleaseFacts["eventType"],
  readonly ReleaseVariant[]
> = {
  preorder_open: [
    {
      usesLabel: true,
      render: (f) =>
        `${asSentence(`${f.artist}, ${f.title}`)} Preorder is open on ${f.label}.`,
    },
    {
      usesLabel: true,
      render: (f) => `${f.title} by ${f.artist} is up for preorder on ${f.label}.`,
    },
    {
      usesLabel: true,
      render: (f) =>
        `${asSentence(`New on ${f.label}: ${f.artist}, ${f.title}`)} Preorders are open.`,
    },
    {
      usesLabel: false,
      render: (f) =>
        `${asSentence(`${f.artist}, ${f.title}`)} Preorder is open.`,
    },
  ],
  release_live: [
    { usesLabel: true, render: (f) => `${f.artist}, ${f.title} is out now on ${f.label}.` },
    {
      usesLabel: false,
      render: (f) => `${f.title} by ${f.artist} just landed. Copies are in the shop.`,
    },
    { usesLabel: true, render: (f) => `Out today: ${f.artist}, ${f.title} on ${f.label}.` },
  ],
  restock: [
    { usesLabel: false, render: (f) => `${f.artist}, ${f.title} is back in stock.` },
    { usesLabel: true, render: (f) => `Restock: ${f.artist}, ${f.title} on ${f.label}.` },
  ],
};

/**
 * The shop's `musiclabel` taxonomy carries placeholder terms for self-released
 * records ("YYK no label") and, for one-off imprints, a term equal to the
 * catalogue number or the record itself. All of them read wrong in
 * "… on <label>", so those releases take the label-free shells.
 */
function hasUsableLabel(facts: ReleaseFacts): boolean {
  const label = facts.label.trim();
  if (!label || /\bno label\b/i.test(label)) return false;

  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const labelKey = key(label);

  return (
    labelKey !== key(facts.catno) &&
    labelKey !== key(facts.artist) &&
    labelKey !== key(facts.title)
  );
}

export function releaseOpeningVariants(
  facts: ReleaseFacts
): readonly ReleaseVariant[] {
  const variants = RELEASE_OPENINGS[facts.eventType];
  if (hasUsableLabel(facts)) return variants;
  return variants.filter((variant) => !variant.usesLabel);
}

const RELEASE_GOALS: Record<ReleaseFacts["eventType"], string> = {
  preorder_open: "Preorder link",
  release_live: "Release link",
  restock: "Restock link",
};

const INSTORE_OPENINGS: readonly ((facts: InstoreFacts) => string)[] = [
  (f) => `${f.artist} played an instore session at Yoyaku. The full set is up.`,
  (f) => `New instore session: ${f.artist} at Yoyaku.`,
];

export function buildCampaignCopy(facts: CampaignFacts): CampaignCopy {
  if (facts.eventType === "instore_published") {
    return {
      name: `Instore ${facts.artist}`,
      goal: "Instore session links",
      openingDmMessage: pickVariant(INSTORE_OPENINGS, facts.artist)(facts),
      openingDmButtonLabel: "Watch",
      dmMessage: pickVariant(REVEAL_VARIANTS, facts.artist),
      linkButtonLabel: "YouTube",
      trackedDestinationUrl: facts.youtubeUrl,
      secondaryDestinationUrl: facts.soundcloudUrl,
      secondaryButtonLabel: "SoundCloud",
    };
  }

  const opening = pickVariant(releaseOpeningVariants(facts), facts.catno).render(
    facts
  );

  return {
    name: `${facts.catno} ${RELEASE_GOALS[facts.eventType]}`,
    goal: RELEASE_GOALS[facts.eventType],
    openingDmMessage: opening,
    openingDmButtonLabel: pickVariant(OPENING_BUTTON_VARIANTS, facts.catno),
    dmMessage: pickVariant(REVEAL_VARIANTS, facts.catno),
    linkButtonLabel:
      facts.eventType === "preorder_open"
        ? preorderButtonLabel(facts.catno)
        : facts.catno.slice(0, META_BUTTON_LIMIT),
    trackedDestinationUrl: facts.url,
  };
}
