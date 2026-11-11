import type { ProductFacts } from "@/lib/assistant/resolve-product";

/**
 * The assistant's campaign payload builder — a pure function so tests pin the
 * exact shape sent to `POST /api/automations`.
 *
 * House rules are baked in, not parameterised: the comment matcher answers
 * any comment (`matchAnyWord: true`, `keywords: []`), a public reply is never
 * sent (`publicReplyEnabled: false`), and the destination is the product
 * permalink (the API applies the DM UTM tags when it creates the tracked
 * link). Follow gates and follow-ups stay off; the builder owns those.
 */

export type AssistantScope = "catalogue" | "specific";

export interface AssistantCopyInput {
  openingDm: string;
  openingButton: string;
  revealDm: string;
  linkButton: string;
}

export interface AssistantPayloadInput {
  facts: Pick<ProductFacts, "sku" | "title" | "catnoTag" | "permalink">;
  copy: AssistantCopyInput;
  scope: AssistantScope;
  /** Specific-post scope only: the published post to bind. */
  postId?: string | null;
  postUrl?: string | null;
  /** Two-step DM (playbook house style); off sends the link DM directly. */
  twoStep: boolean;
  instagramAccountId: string;
  isActive: boolean;
  /** Defaults to `<SKU> · <Title>`; editable in the review screen. */
  name?: string;
}

/** The generated campaign name: readable in the list, never "Campaign for @account". */
export function defaultCampaignName(facts: {
  sku: string;
  title: string;
}): string {
  return `${facts.sku} · ${facts.title}`;
}

/**
 * Build the `POST /api/automations` payload for the chosen scope. The shape
 * matches what `components/campaign-builder.tsx` sends: catalogue scope waits
 * for the next publication carrying the hashtag, specific-post scope binds a
 * published post (`pendingNextReel: false`, `postId` + `postUrl`).
 */
export function buildAssistantPayload(input: AssistantPayloadInput) {
  const catalogue = input.scope === "catalogue";
  const name = (input.name ?? defaultCampaignName(input.facts))
    .trim()
    .slice(0, 100);

  return {
    name,
    instagramAccountId: input.instagramAccountId,
    triggerType: "COMMENT" as const,
    postId: catalogue ? null : input.postId ?? null,
    postUrl: catalogue ? null : input.postUrl ?? null,
    matchAnyPost: false,
    pendingNextReel: catalogue,
    catnoTag: catalogue ? input.facts.catnoTag : null,
    matchAnyWord: true,
    keywords: [] as string[],
    dmMessage: input.copy.revealDm,
    openingDmEnabled: input.twoStep,
    openingDmMessage: input.twoStep ? input.copy.openingDm : null,
    openingDmButtonLabel: input.twoStep ? input.copy.openingButton : null,
    publicReplyEnabled: false,
    publicReplyMessages: [] as string[],
    trackedDestinationUrl: input.facts.permalink,
    linkButtonLabel: input.copy.linkButton,
    secondaryDestinationUrl: "",
    secondaryButtonLabel: "",
    requireFollow: false,
    followPromptMessage: "",
    followPromptButtonLabel: "",
    followUpEnabled: false,
    followUpMessage: "",
    isActive: input.isActive,
  };
}

/**
 * The PATCH body for completing an existing CALENDAR campaign.
 *
 * Calendar owns the binding: `app/api/automations/route.ts` answers 409
 * CALENDAR_BINDING_IMMUTABLE when a Calendar campaign's publication
 * (`pendingNextReel`, `postId`/`postUrl`, `catnoTag`) or its destination URL
 * changes, and refuses `isActive: true` until Meta publication proof. So
 * completing a Calendar campaign from the assistant may touch the copy fields
 * ONLY, and never the activation state — the campaign stays waiting for its
 * Calendar-planned publication. Omitted fields stay unchanged.
 */
export function calendarCompletionPatch(
  input: Pick<AssistantPayloadInput, "facts" | "copy" | "twoStep" | "name">,
) {
  const name = (input.name ?? defaultCampaignName(input.facts))
    .trim()
    .slice(0, 100);

  return {
    name,
    dmMessage: input.copy.revealDm,
    openingDmEnabled: input.twoStep,
    openingDmMessage: input.twoStep ? input.copy.openingDm : null,
    openingDmButtonLabel: input.twoStep ? input.copy.openingButton : null,
    linkButtonLabel: input.copy.linkButton,
  };
}
