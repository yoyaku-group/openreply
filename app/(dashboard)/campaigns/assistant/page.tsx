"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Campaign Assistant
 *
 * One screen: give a product (URL or SKU), optionally paste the post caption,
 * review, validate. Copy comes from the product description via the
 * deterministic `generateCopy` step (`lib/assistant/generate-copy.ts`,
 * provenance "standard"). The AI copywriter (lot S3) upgrades it in the
 * background: the standard copy is shown at once with a "Writing a better
 * version…" badge, the page polls the generation status for up to 25 s, and
 * the AI version replaces the texts only while the user has not edited them
 * (otherwise an explicit "Use it" decides). On failure or timeout the
 * standard copy stays.
 *
 * Saving and validating go through the normal campaign API — this screen
 * never invents a second write path.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import PostPicker from "@/components/post-picker";
import CampaignPreview, { type PreviewTab } from "@/components/campaign-preview";
import { readCache, writeCache } from "@/lib/client-cache";
import { parseCatnoTag } from "@/lib/automations/catalogue";
import { composeCaption, type Check } from "@/lib/assistant/caption";
import { ctaFor } from "@/lib/assistant/caption-cta";
import { generateCopy, releaseFactsFrom } from "@/lib/assistant/generate-copy";
import {
  buildAssistantPayload,
  calendarCompletionPatch,
  defaultCampaignName,
} from "@/lib/assistant/payload";
import type { ProductFacts } from "@/lib/assistant/resolve-product";
import { lintCampaignCopy } from "@/lib/copy/copy-linter";
import {
  META_BODY_LIMIT,
  META_BUTTON_LIMIT,
} from "@/lib/copy/yoyaku-patterns";

type WhenScope = "catalogue" | "published";

interface ExistingCampaign {
  id: string;
  name: string;
  status: string;
  source: string;
}

interface PrepareData {
  facts: ProductFacts;
  caption: ReturnType<typeof composeCaption>;
  copy: ReturnType<typeof generateCopy>;
  lint: unknown;
  checks: { purchasable: boolean };
  existingCampaign: ExistingCampaign | null;
  generationId: string | null;
}

interface AiCopyTexts {
  openingDm: string;
  openingButton: string;
  revealDm: string;
  linkButton: string;
}

type AiStatus =
  | "idle" // no generation for this product (disabled or unbuyable state)
  | "pending" // queued, host worker working
  | "ready" // DONE arrived, not applied yet (the user edited the texts)
  | "ready_applied" // DONE and in the fields
  | "failed"; // FAILED or poll timeout: standard copy stays

const STATE_LABELS: Record<ProductFacts["state"], string> = {
  preorder: "Pre-order",
  coming_soon: "Coming soon",
  sold_out: "Sold out",
  restock: "Back in stock",
  available: "Available",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </div>
  );
}

function Radio({
  checked,
  onSelect,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
        checked ? "border-accent bg-accent/5" : "border-border hover:border-border-hover"
      }`}
    >
      <span
        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
          checked ? "border-accent" : "border-zinc-500"
        }`}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      <span className="flex-1 text-foreground">{children}</span>
    </button>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        on ? "bg-accent" : "bg-zinc-700"
      }`}
    >
      <span
        className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${
          on ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}

function CheckIcon({ level }: { level: Check["level"] }) {
  const cls =
    level === "ok"
      ? "text-success"
      : level === "error"
        ? "text-error"
        : "text-amber-400";
  if (level === "ok") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 shrink-0 ${cls}`}>
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 shrink-0 ${cls}`}>
      {level === "error" ? (
        <path d="M18 6L6 18M6 6l12 12" />
      ) : (
        <>
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
          <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
        </>
      )}
    </svg>
  );
}

function CharCounter({ value, limit }: { value: string; limit: number }) {
  const over = value.length > limit;
  return (
    <span className={`text-xs ${over ? "text-error" : "text-muted"}`}>
      {value.length}/{limit}
    </span>
  );
}

function Field({
  label,
  hint,
  counter,
  children,
}: {
  label: string;
  hint?: string;
  counter?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {counter}
      </span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none";

// Polling cadence for the AI copy status (lot S3): every 1.5 s, give up at 25 s.
const AI_POLL_INTERVAL_MS = 1500;
const AI_POLL_MAX_MS = 25000;

export default function CampaignAssistantPage() {
  const router = useRouter();

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  const [productInput, setProductInput] = useState("");
  const [captionInput, setCaptionInput] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  const [facts, setFacts] = useState<ProductFacts | null>(null);
  const [existingCampaign, setExistingCampaign] =
    useState<ExistingCampaign | null>(null);
  // Missing-fact fixes, typed in the review screen. null = untouched.
  const [artistsOverride, setArtistsOverride] = useState<string | null>(null);
  const [labelOverride, setLabelOverride] = useState<string | null>(null);
  const [tagOverride, setTagOverride] = useState<string | null>(null);

  const [when, setWhen] = useState<WhenScope>("catalogue");
  const [postId, setPostId] = useState<string | null>(null);
  const [postUrl, setPostUrl] = useState<string | null>(null);
  const [postThumb, setPostThumb] = useState<string | null>(null);

  const [twoStep, setTwoStep] = useState(true);
  const [name, setName] = useState("");
  const [openingDm, setOpeningDm] = useState("");
  const [openingButton, setOpeningButton] = useState("");
  const [revealDm, setRevealDm] = useState("");
  const [linkButton, setLinkButton] = useState("");

  // AI copy generation (lot S3). The standard copy is shown at once; the AI
  // version, when it arrives, replaces it only while the user has not edited
  // the texts — otherwise an explicit "Use it" decides.
  const [generationId, setGenerationId] = useState<string | null>(null);
  // The dedupe window can hand back the SAME generation id on a Regenerate;
  // the poll effect is keyed on this nonce too, so a repeated id still
  // restarts polling instead of leaving the badge stuck on "pending".
  const [pollNonce, setPollNonce] = useState(0);
  const [aiStatus, setAiStatus] = useState<AiStatus>("idle");
  const [aiCopy, setAiCopy] = useState<AiCopyTexts | null>(null);
  const [aiPromptVersion, setAiPromptVersion] = useState<number | null>(null);
  const [copyEdited, setCopyEdited] = useState(false);
  // The standard-copy seed the applied AI text was pinned to. A facts edit
  // after prepare changes the seed: the AI text names the OLD facts, so it
  // must not silently come back over the corrected standard copy.
  const [aiPinnedSeed, setAiPinnedSeed] = useState<string | null>(null);

  const [completeId, setCompleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [finishLink, setFinishLink] = useState<{ label: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewTab, setPreviewTab] = useState<PreviewTab>("dm");
  // Prompt-lab entry point (lot S4): owners only.
  const [isOwner, setIsOwner] = useState(false);

  // Load accounts and preselect like the campaign builder.
  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return;
        const next: AccountOption[] = payload.data.instagramAccounts ?? [];
        setAccounts(next);
        setSelectedAccountId(
          (prev) => prev || payload.data.selectedInstagramAccountId || next[0]?.id || ""
        );
      })
      .catch(() => setAccounts([]));
    fetch("/api/workspace/members")
      .then((r) => r.json())
      .then((payload) => {
        if (payload?.success) setIsOwner(payload.data.currentUserRole === "OWNER");
      })
      .catch(() => {});
  }, []);

  // Fetch the connected account's avatar for the phone preview (cache-first).
  useEffect(() => {
    if (!selectedAccountId) return;
    let cancelled = false;
    const cacheKey = `ig-avatar:${selectedAccountId}`;
    const cached = readCache<string | null>(cacheKey, 30 * 60 * 1000);
    // Hydrating state from cache is a legitimate effect use here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cached.data !== null) setAvatarUrl(cached.data);

    const params = new URLSearchParams({ instagramAccountId: selectedAccountId });
    fetch(`/api/instagram/profile?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const url = d.success ? d.data.profilePictureUrl ?? null : null;
        setAvatarUrl(url);
        writeCache(cacheKey, url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId]);

  const username =
    accounts.find((a) => a.id === selectedAccountId)?.username ?? "yourbrand";

  // Facts with the missing-field fixes applied.
  const effectiveFacts: ProductFacts | null = useMemo(() => {
    if (!facts) return null;
    const artists =
      artistsOverride !== null
        ? artistsOverride
            .split("&")
            .map((a) => a.trim())
            .filter(Boolean)
        : facts.artists;
    const label = labelOverride !== null ? labelOverride.trim() : facts.label;
    let catnoTag = facts.catnoTag;
    if (tagOverride !== null) {
      const parsed = parseCatnoTag(tagOverride);
      catnoTag = parsed.ok ? parsed.value : null;
    }
    return {
      ...facts,
      artists,
      label,
      catnoTag,
      hashtag: catnoTag ? `#${catnoTag}` : null,
    };
  }, [facts, artistsOverride, labelOverride, tagOverride]);

  const parsedTagOverride =
    tagOverride !== null ? parseCatnoTag(tagOverride) : null;

  // The caption result is recomputed client-side so the "When" choice takes
  // effect immediately (a published post has nothing to add for the hashtag).
  const captionResult = useMemo(() => {
    if (!effectiveFacts) return null;
    return composeCaption({
      caption: captionInput,
      facts: effectiveFacts,
      cta: ctaFor(effectiveFacts.state),
      alreadyPublished: when === "published",
    });
  }, [effectiveFacts, captionInput, when]);

  // The deterministic copy step runs client-side too — it is pure.
  const generated = useMemo(
    () => (effectiveFacts ? generateCopy(effectiveFacts, captionInput) : null),
    [effectiveFacts, captionInput]
  );

  // Seed the editable fields from the generated copy. Facts-driven changes
  // (artist, label, state, SKU) re-seed; manual edits to the fields survive
  // everything else, including caption edits. The campaign name is seeded by
  // prepare() and stays editable.
  const seedKey = generated?.ok
    ? `${generated.openingDm}\n${generated.openingButton}\n${generated.revealDm}\n${generated.linkButton}`
    : "";
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!generated?.ok) return;
    setOpeningDm(generated.openingDm);
    setOpeningButton(generated.openingButton);
    setRevealDm(generated.revealDm);
    setLinkButton(generated.linkButton);
    // An automatic fill resets the edited flag: the AI swap may proceed again.
    setCopyEdited(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  // The AI version replaces the texts in the fields only while the user has
  // not edited them; otherwise it waits behind the explicit "Use it" button.
  // It applies once against the facts it was generated from: when the facts
  // change afterwards (artist/label/tag corrections), the standard copy
  // reseeds with the corrected names and the stale AI text is dropped — the
  // badge returns to "Standard copy" and Regenerate can queue a fresh one.
  useEffect(() => {
    if (!aiCopy) return;
    if (aiStatus !== "ready" && aiStatus !== "ready_applied") return;
    if (copyEdited) return;
    if (aiPinnedSeed !== null && aiPinnedSeed !== seedKey) {
      setAiCopy(null);
      setAiStatus("idle");
      return;
    }
    setOpeningDm(aiCopy.openingDm);
    setOpeningButton(aiCopy.openingButton);
    setRevealDm(aiCopy.revealDm);
    setLinkButton(aiCopy.linkButton);
    setAiPinnedSeed(seedKey);
    setAiStatus("ready_applied");
  }, [aiCopy, aiStatus, copyEdited, seedKey, aiPinnedSeed]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Poll the generation status while the host worker works. The standard
  // copy is already on screen; polling only upgrades it (or gives up).
  useEffect(() => {
    if (!generationId) return;
    let cancelled = false;
    const startedAt = Date.now();
    async function poll() {
      while (!cancelled && Date.now() - startedAt < AI_POLL_MAX_MS) {
        try {
          const res = await fetch(`/api/assistant/generations/${generationId}`, {
            cache: "no-store",
          });
          const payload = await res.json();
          if (cancelled) return;
          if (payload.success) {
            const status = payload.data as {
              status: string;
              copy?: AiCopyTexts;
              promptVersion?: number;
            };
            if (typeof status.promptVersion === "number") {
              setAiPromptVersion(status.promptVersion);
            }
            if (status.status === "DONE" && status.copy) {
              setAiCopy(status.copy);
              setAiStatus("ready");
              return;
            }
            if (status.status === "FAILED") {
              setAiStatus("failed");
              return;
            }
          }
        } catch {
          // A transient poll error is not a failure of the generation.
        }
        await new Promise((resolve) => setTimeout(resolve, AI_POLL_INTERVAL_MS));
      }
      if (!cancelled) {
        setAiStatus((prev) => (prev === "pending" ? "failed" : prev));
      }
    }
    void poll();
    return () => {
      cancelled = true;
    };
  }, [generationId, pollNonce]);

  function applyAiCopy() {
    if (!aiCopy) return;
    setOpeningDm(aiCopy.openingDm);
    setOpeningButton(aiCopy.openingButton);
    setRevealDm(aiCopy.revealDm);
    setLinkButton(aiCopy.linkButton);
    setCopyEdited(false);
    // An explicit Use it is the user's call even after a facts edit; pin it
    // so the swap effect does not undo the click.
    setAiPinnedSeed(seedKey);
    setAiStatus("ready_applied");
  }

  const liveLint = useMemo(() => {
    if (!effectiveFacts) return null;
    return lintCampaignCopy(
      {
        // goal is not user-visible in the assistant; the linter only reads the
        // message and button fields.
        name,
        goal: "",
        openingDmMessage: openingDm,
        openingDmButtonLabel: openingButton,
        dmMessage: revealDm,
        linkButtonLabel: linkButton,
        trackedDestinationUrl: effectiveFacts.permalink,
      },
      releaseFactsFrom(effectiveFacts)
    );
  }, [effectiveFacts, name, openingDm, openingButton, revealDm, linkButton]);

  // Pin the standard-copy seed of the facts the SERVER generated from (the
  // response carries them). The AI text may only replace copy rendered from
  // these same facts — a later correction changes the seed and the stale AI
  // text is dropped instead of silently restoring old names.
  function pinSeedFromFacts(facts: ProductFacts, captionText: string) {
    const seedGenerated = generateCopy(facts, captionText);
    setAiPinnedSeed(
      seedGenerated.ok
        ? `${seedGenerated.openingDm}\n${seedGenerated.openingButton}\n${seedGenerated.revealDm}\n${seedGenerated.linkButton}`
        : ""
    );
  }

  async function prepare() {
    setPrepareError(null);
    if (!productInput.trim()) {
      setPrepareError("Enter a product URL or a SKU.");
      return;
    }
    setPreparing(true);
    try {
      const res = await fetch("/api/assistant/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: productInput.trim(),
          caption: captionInput.trim() || undefined,
          instagramAccountId: selectedAccountId || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setPrepareError(
          data.error ?? "The product could not be read from the shop."
        );
        return;
      }
      const prepared = data.data as PrepareData;
      setFacts(prepared.facts);
      setExistingCampaign(prepared.existingCampaign);
      setCompleteId(null);
      setArtistsOverride(null);
      setLabelOverride(null);
      setTagOverride(null);
      setGenerationId(prepared.generationId ?? null);
      setAiCopy(null);
      setAiPromptVersion(null);
      setCopyEdited(false);
      pinSeedFromFacts(prepared.facts, captionInput);
      setPollNonce((n) => n + 1);
      setAiStatus(prepared.generationId ? "pending" : "idle");
      setName(
        defaultCampaignName({
          sku: prepared.facts.sku,
          title: prepared.facts.title,
        })
      );
      setWhen("catalogue");
      setPostId(null);
      setPostUrl(null);
      setPostThumb(null);
    } catch {
      setPrepareError("The product could not be read from the shop.");
    } finally {
      setPreparing(false);
    }
  }

  // Re-queue a generation WITHOUT the full prepare reset: the user's fact
  // corrections, campaign name, when-scope and copy edits all stay. The new
  // generation is pinned to the server's resolved facts; if those differ
  // from the corrected facts, the stale-seed guard drops its copy on arrival.
  async function regenerate() {
    setPrepareError(null);
    if (!productInput.trim()) {
      setPrepareError("Enter a product URL or a SKU.");
      return;
    }
    setPreparing(true);
    try {
      const res = await fetch("/api/assistant/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: productInput.trim(),
          caption: captionInput.trim() || undefined,
          instagramAccountId: selectedAccountId || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setAiStatus("failed");
        setPrepareError(data.error ?? "The product could not be read from the shop.");
        return;
      }
      const prepared = data.data as PrepareData;
      setGenerationId(prepared.generationId ?? null);
      setAiCopy(null);
      setAiPromptVersion(null);
      // copyEdited is deliberately kept: a user who hand-edited the texts
      // and asks for a Regenerate still gets the result behind "Use it" —
      // their written copy is never silently overwritten.
      pinSeedFromFacts(prepared.facts, captionInput);
      setPollNonce((n) => n + 1);
      setAiStatus(prepared.generationId ? "pending" : "idle");
    } catch {
      setAiStatus("failed");
      setPrepareError("The product could not be read from the shop.");
    } finally {
      setPreparing(false);
    }
  }

  async function submit(activeValue: boolean) {
    setFinishError(null);
    setFinishLink(null);

    if (!effectiveFacts) return setFinishError("Prepare a product first.");
    if (!selectedAccountId) return setFinishError("Connect an Instagram account first.");
    if (!generated?.ok) {
      return setFinishError(
        `Facts are missing, copy cannot be generated: ${generated?.error === "MISSING_FACTS" ? generated.missing.join(", ") : "unknown"}`
      );
    }
    if (when === "catalogue" && !effectiveFacts.catnoTag) {
      return setFinishError(
        "The SKU is not a valid catalogue reference. Fix the hashtag chip or bind a published post."
      );
    }
    if (when === "published" && !postId) {
      return setFinishError("Pick the published post or reel.");
    }
    if (!revealDm.trim()) return setFinishError("Add the DM with the link.");
    if (twoStep && (!openingDm.trim() || !openingButton.trim())) {
      return setFinishError("The opening DM needs a message and a button label.");
    }
    // Validation is a hard gate: a caption that carries another reference
    // sends two messages per commenter, copy that fails the YOYAKU linter
    // must not go live, and a product with nothing to buy yet is draft-only.
    if (activeValue) {
      if (notPurchasable) {
        return setFinishError(
          "This product cannot be bought yet: save as draft."
        );
      }
      const captionErrors =
        captionResult?.checks.filter((check) => check.level === "error") ?? [];
      if (captionErrors.length > 0) {
        return setFinishError(captionErrors.map((c) => c.message).join(" "));
      }
      if (liveLint && !liveLint.ok) {
        return setFinishError(
          "The copy fails the YOYAKU linter. Fix the flagged messages and buttons before validating."
        );
      }
    }

    const payload = buildAssistantPayload({
      facts: effectiveFacts,
      copy: { openingDm, openingButton, revealDm, linkButton },
      scope: when === "catalogue" ? "catalogue" : "specific",
      postId,
      postUrl,
      twoStep,
      instagramAccountId: selectedAccountId,
      isActive: activeValue,
      name,
    });

    // Completing an existing campaign with "Save draft" must not silently
    // pause it: the draft button saves the copy edits and leaves the live
    // activation state untouched (only "Validate for publication" arms it).
    // A Calendar campaign goes further: its binding and destination are
    // Calendar-owned and its activation waits for Meta proof, so the PATCH
    // carries the copy fields only.
    const body = calendarComplete
      ? calendarCompletionPatch({
          facts: effectiveFacts,
          copy: { openingDm, openingButton, revealDm, linkButton },
          twoStep,
          name,
        })
      : completeId && !activeValue
        ? { ...payload, isActive: undefined }
        : payload;

    setSaving(true);
    try {
      const res = completeId
        ? await fetch(`/api/automations?id=${completeId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch("/api/automations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const data = await res.json();
      if (data.success) {
        // Fire-and-forget provenance record (lot S4 feed): what the team
        // validated, how far it drifted from the model output, and the
        // campaign it landed on. Never blocks the save.
        const savedAutomationId =
          typeof data.data?.id === "string" ? data.data.id : completeId;
        if (generationId && savedAutomationId) {
          void fetch(`/api/assistant/generations/${generationId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              automationId: savedAutomationId,
              finalCopy: {
                openingDm: body.openingDmMessage ?? null,
                openingButton: body.openingDmButtonLabel ?? null,
                revealDm: body.dmMessage,
                linkButton: body.linkButtonLabel,
              },
            }),
          }).catch(() => {});
        }
        // refresh() busts the router cache so the list reflects the save.
        router.push("/campaigns");
        router.refresh();
        return;
      }
      if (typeof data.conflictUrl === "string") {
        setFinishLink({ label: "Open the existing campaign", url: data.conflictUrl });
      } else if (typeof data.fixUrl === "string") {
        setFinishLink({ label: "How to fix the account", url: data.fixUrl });
      }
      const fieldErrors = data.details?.fieldErrors as
        | Record<string, string[]>
        | undefined;
      const firstField = fieldErrors && Object.keys(fieldErrors)[0];
      setFinishError(
        firstField
          ? `${firstField}: ${fieldErrors[firstField][0]}`
          : data.error ?? "Failed to save the campaign"
      );
    } catch {
      setFinishError("Failed to save the campaign");
    } finally {
      setSaving(false);
    }
  }

  async function copyFinalCaption() {
    const text = captionResult?.final ?? captionResult?.additions.join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the text stays visible above.
    }
  }

  function handlePostSelect(
    id: string,
    url?: string,
    thumb?: string
  ) {
    setPostId(id);
    setPostUrl(url ?? null);
    setPostThumb(thumb ?? null);
  }

  const previewThumb = (when === "published" ? postThumb : null) ?? effectiveFacts?.imageUrl ?? null;
  const previewCaption = captionResult?.final ?? captionInput;

  // Nothing to buy yet: drafts only, validation is refused.
  const notPurchasable =
    effectiveFacts?.state === "coming_soon" ||
    effectiveFacts?.state === "sold_out";
  // Completing a Calendar campaign touches the copy fields only — the API
  // refuses binding and destination edits, and arming waits for Meta proof.
  const calendarComplete =
    completeId !== null && existingCampaign?.source === "CALENDAR";

  const missing = facts?.missing ?? [];

  return (
    <div className="space-y-8">
      {isOwner && (
        <div className="flex justify-end">
          <Link
            href="/settings/copywriter"
            className="text-xs font-medium text-muted underline hover:text-foreground"
          >
            Improve the AI copy
          </Link>
        </div>
      )}

      {/* 1. Product and caption */}
      <Section title="Product">
        <div className="grid gap-4 lg:grid-cols-2">
          <Field
            label="Product URL or SKU"
            hint="A yoyaku.io release or product link, or the SKU exactly as printed on the shop, separators included (LM-02, not LM02)."
          >
            <input
              value={productInput}
              onChange={(e) => setProductInput(e.target.value)}
              placeholder="https://yoyaku.io/release/… or LM-02"
              className={inputClass}
            />
          </Field>
          <AccountSelect
            accounts={accounts}
            value={selectedAccountId}
            onChange={(value) => {
              if (value === selectedAccountId) return;
              setSelectedAccountId(value);
              // The existing-campaign lookup was scoped to the account of the
              // last Prepare; a different account invalidates the banner and
              // the completion target.
              setExistingCampaign(null);
              setCompleteId(null);
            }}
            includeAll={false}
          />
        </div>
        <Field
          label="Post caption (optional)"
          hint="Leave empty for a simple product: the copy comes from the product description."
        >
          <textarea
            value={captionInput}
            onChange={(e) => setCaptionInput(e.target.value)}
            rows={4}
            placeholder="Paste the caption of the post that will carry this release…"
            className={`${inputClass} resize-y`}
          />
        </Field>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void prepare()}
            disabled={preparing}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {preparing ? "Preparing…" : "Prepare"}
          </button>
          {prepareError && (
            <span role="alert" className="text-sm text-error">
              {prepareError}
            </span>
          )}
        </div>
      </Section>

      {/* 2. Review */}
      {effectiveFacts && captionResult && (
        <>
          {existingCampaign && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <span className="text-amber-300">
                A campaign already exists for {effectiveFacts.hashtag ?? "this reference"} (
                {existingCampaign.source}, {existingCampaign.status}).
              </span>
              {completeId === existingCampaign.id ? (
                <span className="text-xs text-muted">
                  {calendarComplete
                    ? "Finishing this Calendar campaign — only the copy is updated, it stays waiting for its Calendar-planned publication."
                    : "Finishing this campaign — saving updates it."}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Link
                    href={`/campaigns/${existingCampaign.id}`}
                    className="text-xs text-muted underline hover:text-foreground"
                  >
                    Open it
                  </Link>
                  <button
                    type="button"
                    onClick={() => setCompleteId(existingCampaign.id)}
                    className="rounded border border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/10"
                  >
                    Complete this campaign
                  </button>
                </span>
              )}
            </div>
          )}

          <Section title="Facts">
            <div className="flex flex-wrap items-center gap-3">
              {effectiveFacts.imageUrl && (
                <img
                  src={effectiveFacts.imageUrl}
                  alt=""
                  className="h-16 w-16 rounded border border-border object-cover"
                />
              )}
              <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted">
                SKU {effectiveFacts.sku}
              </span>
              <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted">
                {effectiveFacts.title}
              </span>
              <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted">
                {STATE_LABELS[effectiveFacts.state]}
              </span>
              {notPurchasable && (
                <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-400">
                  Cannot be bought yet — drafts only
                </span>
              )}
              {effectiveFacts.hashtag ? (
                <code className="rounded bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">
                  {effectiveFacts.hashtag}
                </code>
              ) : (
                <span className="flex items-center gap-2">
                  <input
                    value={tagOverride ?? ""}
                    onChange={(e) => setTagOverride(e.target.value)}
                    placeholder="Catalogue hashtag, e.g. #LM02"
                    className={`${inputClass} w-56`}
                  />
                  {parsedTagOverride && !parsedTagOverride.ok && (
                    <span className="text-xs text-error">
                      {parsedTagOverride.message}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Artists"
                hint={
                  missing.includes("artist")
                    ? "Missing from the shop — type it, joined with &."
                    : undefined
                }
              >
                <input
                  value={
                    artistsOverride ??
                    (facts?.artists.length ? facts.artists.join(" & ") : "")
                  }
                  onChange={(e) => setArtistsOverride(e.target.value)}
                  placeholder="Nuron & Fugue"
                  className={inputClass}
                />
              </Field>
              <Field
                label="Label"
                hint={
                  missing.includes("label")
                    ? "Missing from the shop — type it."
                    : undefined
                }
              >
                <input
                  value={labelOverride ?? facts?.label ?? ""}
                  onChange={(e) => setLabelOverride(e.target.value)}
                  placeholder="Blueprint ARchives"
                  className={inputClass}
                />
              </Field>
            </div>
            {effectiveFacts.description && (
              <p className="max-w-2xl rounded border border-border bg-surface p-3 text-xs leading-relaxed text-muted">
                {effectiveFacts.description}
              </p>
            )}
          </Section>

          <Section title="Caption checks">
            <ul className="space-y-1.5">
              {captionResult.checks.map((check) => (
                <li key={check.code + check.message} className="flex items-start gap-2 text-sm">
                  <CheckIcon level={check.level} />
                  <span className="text-foreground">{check.message}</span>
                </li>
              ))}
              {captionResult.checks.length === 0 && when === "published" && (
                <li className="text-sm text-muted">
                  The post is already published: nothing to add to its caption.
                </li>
              )}
            </ul>
            {captionResult.additions.length > 0 && (
              <p className="text-sm text-muted">
                Add to your caption:{" "}
                <code className="rounded bg-surface px-2 py-0.5 text-foreground">
                  {captionResult.additions.join(" ")}
                </code>
              </p>
            )}
          </Section>

          <Section title="When">
            <Radio
              checked={when === "catalogue"}
              onSelect={() => setWhen("catalogue")}
            >
              Next post with {effectiveFacts.hashtag ?? "the catalogue hashtag"}
            </Radio>
            {when === "catalogue" && !effectiveFacts.hashtag && (
              <p className="text-xs text-error">
                This SKU is not a valid catalogue reference. Fix the hashtag
                above, or choose a published post.
              </p>
            )}
            <Radio
              checked={when === "published"}
              onSelect={() => setWhen("published")}
            >
              Post already published
            </Radio>
            {when === "published" && (
              <div className="rounded-lg border border-border p-2">
                <PostPicker
                  selectedPostId={postId}
                  instagramAccountId={selectedAccountId}
                  onSelect={handlePostSelect}
                />
              </div>
            )}
          </Section>

          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-6">
              <Section title="Campaign">
                <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                  <span className="text-sm text-foreground">
                    Two-step DM (opening message, then the link)
                  </span>
                  <Toggle
                    on={twoStep}
                    onToggle={() => setTwoStep(!twoStep)}
                  />
                </div>
                <Field
                  label="Campaign name"
                  hint="Shown in the campaign list. Never “Campaign for @account”."
                >
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  {(aiStatus === "idle" || aiStatus === "failed" || !generated?.ok) && (
                    <span className="inline-flex w-fit rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                      {generated?.ok ? "Standard copy" : "Copy blocked"}
                    </span>
                  )}
                  {aiStatus === "pending" && generated?.ok && (
                    <span className="inline-flex w-fit animate-pulse rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                      Writing a better version…
                    </span>
                  )}
                  {aiStatus === "ready" && (
                    <span className="inline-flex w-fit items-center gap-2 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                      AI version ready
                      <button
                        type="button"
                        onClick={applyAiCopy}
                        className="rounded bg-accent px-2 py-0.5 font-medium text-white hover:bg-accent-hover"
                      >
                        Use it
                      </button>
                    </span>
                  )}
                  {aiStatus === "ready_applied" && (
                    <span className="inline-flex w-fit rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                      AI · v{aiPromptVersion ?? "?"}
                    </span>
                  )}
                  {effectiveFacts &&
                    generated?.ok &&
                    effectiveFacts.state !== "coming_soon" &&
                    effectiveFacts.state !== "sold_out" && (
                      <button
                        type="button"
                        onClick={() => void regenerate()}
                        disabled={preparing || aiStatus === "pending"}
                        className="rounded border border-border px-2.5 py-1 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
                      >
                        Regenerate AI copy
                      </button>
                    )}
                </div>
                {generated && !generated.ok && (
                  <p className="text-sm text-error">
                    Missing facts, copy cannot be generated:{" "}
                    {generated.missing.join(", ")}. Fill them in above.
                  </p>
                )}
                {liveLint && !liveLint.ok && (
                  <ul className="space-y-1">
                    {liveLint.violations.map((violation, i) => (
                      <li
                        key={`${violation.rule}-${i}`}
                        className="text-xs text-error"
                      >
                        {violation.rule}: {violation.detail}
                      </li>
                    ))}
                  </ul>
                )}
                {liveLint?.ok && (
                  <p className="text-xs text-success">
                    Copy passes the YOYAKU linter.
                  </p>
                )}
              </Section>

              <Section title="DM copy">
                {twoStep && (
                  <div className="space-y-3">
                    <Field
                      label="Opening DM"
                      counter={<CharCounter value={openingDm} limit={META_BODY_LIMIT} />}
                    >
                      <textarea
                        value={openingDm}
                        onChange={(e) => {
                          setOpeningDm(e.target.value);
                          setCopyEdited(true);
                        }}
                        rows={3}
                        className={`${inputClass} resize-y`}
                      />
                    </Field>
                    <Field
                      label="Opening button"
                      counter={<CharCounter value={openingButton} limit={META_BUTTON_LIMIT} />}
                    >
                      <input
                        value={openingButton}
                        onChange={(e) => {
                          setOpeningButton(e.target.value);
                          setCopyEdited(true);
                        }}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                )}
                <Field
                  label="Link DM"
                  counter={<CharCounter value={revealDm} limit={META_BODY_LIMIT} />}
                >
                  <textarea
                    value={revealDm}
                    onChange={(e) => {
                      setRevealDm(e.target.value);
                      setCopyEdited(true);
                    }}
                    rows={3}
                    className={`${inputClass} resize-y`}
                  />
                </Field>
                <Field
                  label="Link button"
                  counter={<CharCounter value={linkButton} limit={META_BUTTON_LIMIT} />}
                >
                  <input
                    value={linkButton}
                    onChange={(e) => {
                      setLinkButton(e.target.value);
                      setCopyEdited(true);
                    }}
                    className={inputClass}
                  />
                </Field>
                <p className="text-xs text-muted">
                  Destination: {effectiveFacts.permalink || "—"}
                </p>
              </Section>

              <Section title="Finish">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void copyFinalCaption()}
                    className="rounded border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground"
                  >
                    {copied ? "Copied!" : "Copy final caption"}
                  </button>
                  {calendarComplete ? (
                    <button
                      type="button"
                      onClick={() => void submit(false)}
                      disabled={saving}
                      className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      Save copy edits
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void submit(false)}
                        disabled={saving}
                        className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                      >
                        Save draft
                      </button>
                      <button
                        type="button"
                        onClick={() => void submit(true)}
                        disabled={saving}
                        className="rounded border border-accent px-4 py-2 text-sm font-medium text-accent hover:bg-accent/5 disabled:opacity-50"
                      >
                        Validate for publication
                      </button>
                    </>
                  )}
                </div>
                {notPurchasable && (
                  <p className="text-xs text-amber-400">
                    This product cannot be bought yet. Save as a draft and
                    prepare it again to validate once it is purchasable.
                  </p>
                )}
                {finishError && (
                  <div role="alert" className="space-y-1 rounded border border-error/20 bg-error/10 p-3 text-sm text-error">
                    <p>{finishError}</p>
                    {finishLink && (
                      <Link
                        href={finishLink.url}
                        className="text-xs underline hover:text-foreground"
                      >
                        {finishLink.label}
                      </Link>
                    )}
                  </div>
                )}
                <p className="text-xs text-muted">
                  Saving uses the normal campaign API: a draft stays out of the
                  queue, validating arms it. Comments already posted on a
                  published post are picked up by the reconciler.
                </p>
              </Section>
            </div>

            <div>
              <CampaignPreview
                tab={previewTab}
                onTabChange={setPreviewTab}
                username={username}
                avatarUrl={avatarUrl}
                postThumb={previewThumb}
                caption={previewCaption}
                sampleComment={effectiveFacts.sku}
                publicReplyEnabled={false}
                publicReplyMessage=""
                openingDmEnabled={twoStep}
                openingDmMessage={openingDm}
                openingDmButtonLabel={openingButton}
                revealMessage={revealDm}
                hasLink
                linkButtonLabel={linkButton}
                hasSecondLink={false}
                secondLinkButtonLabel=""
                requireFollow={false}
                followPromptMessage=""
                followPromptButtonLabel=""
                followUpEnabled={false}
                followUpMessage=""
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
