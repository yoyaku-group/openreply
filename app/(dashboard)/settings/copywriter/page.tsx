"use client";

/**
 * Prompt lab (lot S4) — improve the AI campaign copy without a deploy.
 *
 * Owners only for writes (edit, test, activate, revert, examples); editors
 * may read. Every change creates a NEW prompt version (append-only), so the
 * per-version metrics stay attributable. Trials run the draft prompt on the
 * last 5 distinct inputs and never touch a campaign.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { wordDiff, type DiffToken } from "@/lib/copywriter/diff";

interface PromptVersion {
  id: string;
  version: number;
  body: string;
  model: string;
  isActive: boolean;
  authorEmail: string;
  reason: string;
  examples: unknown;
  createdAt: string;
}

interface PromptsData {
  versions: PromptVersion[];
  active: PromptVersion | null;
  canWrite: boolean;
}

interface VersionMetrics {
  promptVersion: number;
  generations: number;
  lintPassFirstAttempt: number;
  repairRate: number;
  fallbackRate: number;
  acceptedWithoutEdit: number;
  medianEditDistance: number | null;
  medianLatencyMs: number | null;
  tierMix: Record<string, number>;
  enoughData: boolean;
}

interface CopyTextsShape {
  openingDm: string | null;
  openingButton: string | null;
  revealDm: string;
  linkButton: string;
}

interface GenerationRow {
  id: string;
  createdAt: string;
  status: string;
  attempt: number;
  promptVersion: number;
  tier: string | null;
  latencyMs: number | null;
  failureCode: string | null;
  editDistance: number | null;
  hasFinalCopy: boolean;
  output: unknown;
  finalCopy: unknown;
  facts: { sku?: string; title?: string; label?: string; state?: string };
  caption: string;
  renderedPrompt: string;
  campaignName: string | null;
}

interface TrialItem {
  id: string;
  status: "PENDING" | "CLAIMED" | "DONE" | "FAILED";
  lintOk: boolean;
  lintErrors: unknown;
  output: unknown;
  tier: string | null;
  latencyMs: number | null;
  promptVersion: number;
  baseline: {
    generationId: string;
    promptVersion: number;
    status: string;
    output: unknown;
  } | null;
  input: unknown;
}

interface TrialVerdictData {
  ready: boolean;
  trialPass: number;
  baselinePass: number;
  gateOk: boolean;
}

interface CampaignHit {
  id: string;
  name: string;
  catnoTag: string | null;
  isActive: boolean;
}

const FIELD_LABELS: Array<[keyof CopyTextsShape, string]> = [
  ["openingDm", "Opening DM"],
  ["openingButton", "Opening button"],
  ["revealDm", "Link DM"],
  ["linkButton", "Link button"],
];

const TRIAL_POLL_INTERVAL_MS = 1500;
const TRIAL_POLL_MAX_MS = 60000;

const inputClass =
  "w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none";

function copyTexts(value: unknown): CopyTextsShape | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const str = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  const revealDm = str("revealDm");
  const linkButton = str("linkButton");
  if (revealDm === null || linkButton === null) return null;
  return {
    openingDm: str("openingDm"),
    openingButton: str("openingButton"),
    revealDm,
    linkButton,
  };
}

function readExamples(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** SKU and title out of a generation's stored input block. */
function factsOfInput(input: unknown): { sku?: string; title?: string } {
  if (typeof input !== "object" || input === null) return {};
  const facts = (input as Record<string, unknown>).facts;
  if (typeof facts !== "object" || facts === null) return {};
  const record = facts as Record<string, unknown>;
  return {
    sku: typeof record.sku === "string" ? record.sku : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
  };
}

function StateBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    DONE: "bg-success/10 text-success",
    FAILED: "bg-error/10 text-error",
    CLAIMED: "bg-accent/10 text-accent",
    PENDING: "bg-amber-500/10 text-amber-400",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status] ?? "bg-surface text-muted"}`}
    >
      {status}
    </span>
  );
}

/** Split a prompt body so {{placeholders}} render highlighted. */
function PlaceholderBody({ body }: { body: string }) {
  const parts = useMemo(() => {
    const out: Array<{ text: string; placeholder: boolean }> = [];
    const re = /\{\{[^{}]+\}\}/g;
    let last = 0;
    for (const match of body.matchAll(re)) {
      const start = match.index ?? 0;
      if (start > last) out.push({ text: body.slice(last, start), placeholder: false });
      out.push({ text: match[0], placeholder: true });
      last = start + match[0].length;
    }
    if (last < body.length) out.push({ text: body.slice(last), placeholder: false });
    return out;
  }, [body]);
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface p-3 text-xs leading-relaxed text-muted">
      {parts.map((part, i) =>
        part.placeholder ? (
          <mark key={i} className="rounded bg-accent/15 px-1 font-semibold text-accent">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </pre>
  );
}

/** One diff side: `side` picks which ops this column displays. */
function DiffSide({
  tokens,
  side,
}: {
  tokens: DiffToken[];
  side: "old" | "new";
}) {
  const shown = tokens.filter((token) =>
    side === "old" ? token.op !== "add" : token.op !== "remove"
  );
  if (shown.length === 0) {
    return <span className="text-xs text-zinc-500">—</span>;
  }
  return (
    <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
      {shown.map((token, i) =>
        token.op === "equal" ? (
          <span key={i}>{token.value} </span>
        ) : side === "old" ? (
          <span key={i} className="rounded bg-error/15 text-error line-through">
            {token.value}{" "}
          </span>
        ) : (
          <span key={i} className="rounded bg-success/15 font-medium text-success">
            {token.value}{" "}
          </span>
        )
      )}
    </p>
  );
}

function CopyDiff({ output, final }: { output: CopyTextsShape; final: CopyTextsShape }) {
  return (
    <div className="space-y-2">
      {FIELD_LABELS.map(([key, label]) => {
        const ai = output[key] ?? "";
        const validated = final[key] ?? "";
        const tokens = wordDiff(ai, validated);
        const unchanged = tokens.every((token) => token.op === "equal");
        return (
          <div key={key} className="rounded border border-border p-2">
            <p className="mb-1 flex items-center justify-between text-xs font-medium text-muted">
              <span>{label}</span>
              {unchanged && <span className="text-success">unchanged</span>}
            </p>
            {unchanged ? (
              <p className="text-xs text-foreground">{ai}</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded bg-surface p-2">
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">AI output</p>
                  <DiffSide tokens={tokens} side="old" />
                </div>
                <div className="rounded bg-surface p-2">
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">Validated</p>
                  <DiffSide tokens={tokens} side="new" />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function CopywriterLabPage() {
  const [prompts, setPrompts] = useState<PromptsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<VersionMetrics[]>([]);
  const [generations, setGenerations] = useState<GenerationRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Revert flow.
  const [revertTarget, setRevertTarget] = useState<PromptVersion | null>(null);
  const [revertReason, setRevertReason] = useState("");

  // Example picking from a campaign search.
  const [campaignQuery, setCampaignQuery] = useState("");
  const [campaignHits, setCampaignHits] = useState<CampaignHit[]>([]);

  // Edit → test → activate flow.
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [draftModel, setDraftModel] = useState<"haiku" | "sonnet">("haiku");
  const [draftReason, setDraftReason] = useState("");
  const [trialIds, setTrialIds] = useState<string[] | null>(null);
  const [trialItems, setTrialItems] = useState<TrialItem[]>([]);
  const [verdict, setVerdict] = useState<TrialVerdictData | null>(null);
  const [override, setOverride] = useState(false);
  const [trialStalled, setTrialStalled] = useState(false);

  // The trial gate is bound to the exact draft body + model on the server
  // (body hash); dropping the stale results on any edit keeps the screen
  // honest with that binding.
  function resetTrial() {
    setTrialIds(null);
    setTrialItems([]);
    setVerdict(null);
    setOverride(false);
    setTrialStalled(false);
  }

  const active = prompts?.active ?? null;
  const canWrite = prompts?.canWrite ?? false;
  const examples = useMemo(() => readExamples(active?.examples), [active]);

  const loadPrompts = useCallback(async () => {
    const res = await fetch("/api/copywriter/prompts", { cache: "no-store" });
    const payload = await res.json().catch(() => null);
    if (!payload?.success) {
      setLoadError(
        res.status === 403
          ? "The prompt lab is restricted to workspace owners."
          : payload?.error ?? "The prompt lab could not be loaded."
      );
      return;
    }
    setPrompts(payload.data as PromptsData);
    setLoadError(null);
  }, []);

  useEffect(() => {
    // Initial load inlined (setState-in-effect rule): the callback form is
    // reserved for refreshes after a write, which run in event handlers.
    fetch("/api/copywriter/prompts", { cache: "no-store" })
      .then((res) => res.json().catch(() => null))
      .then((payload) => {
        if (!payload?.success) {
          setLoadError(
            payload?.error === "FORBIDDEN"
              ? "The prompt lab is restricted to workspace owners."
              : payload?.error ?? "The prompt lab could not be loaded."
          );
          return;
        }
        setPrompts(payload.data as PromptsData);
        setLoadError(null);
      })
      .catch(() => setLoadError("The prompt lab could not be loaded."));
    fetch("/api/copywriter/metrics", { cache: "no-store" })
      .then((res) => res.json())
      .then((payload) => {
        if (payload?.success) setMetrics(payload.data.metrics as VersionMetrics[]);
      })
      .catch(() => {});
    fetch("/api/copywriter/generations?limit=20", { cache: "no-store" })
      .then((res) => res.json())
      .then((payload) => {
        if (payload?.success) setGenerations(payload.data.generations as GenerationRow[]);
      })
      .catch(() => {});
  }, []);

  // Poll trial results while the worker runs, up to 60 s (assistant cadence).
  useEffect(() => {
    if (!trialIds || trialIds.length === 0) return;
    const ids = trialIds;
    let cancelled = false;
    const startedAt = Date.now();
    async function poll() {
      while (!cancelled && Date.now() - startedAt < TRIAL_POLL_MAX_MS) {
        try {
          const res = await fetch(
            `/api/copywriter/trials?ids=${encodeURIComponent(ids.join(","))}`,
            { cache: "no-store" }
          );
          const payload = await res.json();
          if (cancelled) return;
          if (payload?.success) {
            const items = payload.data.results as TrialItem[];
            setTrialItems(items);
            setVerdict(payload.data.verdict as TrialVerdictData | null);
            if (items.every((item) => item.status === "DONE" || item.status === "FAILED")) {
              return;
            }
          }
        } catch {
          // A transient poll error is not a failed run.
        }
        await new Promise((resolve) => setTimeout(resolve, TRIAL_POLL_INTERVAL_MS));
      }
      if (!cancelled) {
        // The 60 s window closed with rows still in flight: say so instead
        // of leaving a silent "Trial running…" button.
        setTrialStalled(true);
      }
    }
    void poll();
    return () => {
      cancelled = true;
    };
  }, [trialIds]);

  async function postJson(url: string, body: unknown): Promise<{ ok: boolean; payload: { success?: boolean; error?: string } }> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    return { ok: res.ok && payload?.success !== false, payload };
  }

  async function runAction(action: () => Promise<{ ok: boolean; payload: { success?: boolean; error?: string } }>) {
    setBusy(true);
    setActionError(null);
    const result = await action();
    if (!result.ok) setActionError(result.payload.error ?? "The change was refused.");
    await loadPrompts();
    setBusy(false);
  }

  function revertVersion(version: PromptVersion) {
    if (!revertReason.trim()) {
      setActionError("A reason is required to revert.");
      return;
    }
    void runAction(async () => {
      const result = await postJson(`/api/copywriter/prompts/${version.id}/revert`, {
        reason: revertReason.trim(),
      });
      if (result.ok) {
        setRevertTarget(null);
        setRevertReason("");
      }
      return result;
    });
  }

  function makeExample(generationId: string) {
    void runAction(() =>
      postJson("/api/copywriter/prompts", { addExample: { generationId } })
    );
  }

  function makeExampleFromCampaign(automationId: string) {
    void runAction(async () => {
      const result = await postJson("/api/copywriter/prompts", {
        addExample: { automationId },
      });
      if (result.ok) {
        setCampaignQuery("");
        setCampaignHits([]);
      }
      return result;
    });
  }

  function removeExample(index: number) {
    void runAction(() =>
      postJson("/api/copywriter/prompts", { removeExampleIndex: index })
    );
  }

  function searchCampaigns() {
    if (campaignQuery.trim().length < 2) return;
    fetch(`/api/copywriter/campaigns?q=${encodeURIComponent(campaignQuery.trim())}`, {
      cache: "no-store",
    })
      .then((res) => res.json())
      .then((payload) => {
        if (payload?.success) setCampaignHits(payload.data.campaigns as CampaignHit[]);
      })
      .catch(() => {});
  }

  function startEditing() {
    setDraftBody(active?.body ?? "");
    setDraftModel((active?.model as "haiku" | "sonnet") ?? "haiku");
    setDraftReason("");
    setEditing(true);
    setTrialIds(null);
    setTrialItems([]);
    setVerdict(null);
    setOverride(false);
  }

  function startTrial() {
    if (!active) return;
    setActionError(null);
    void (async () => {
      setBusy(true);
      const res = await fetch("/api/copywriter/trials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: draftBody, model: draftModel }),
      });
      const payload = await res.json().catch(() => ({}));
      setBusy(false);
      if (!payload?.success) {
        setActionError(payload?.error ?? "The trial run was refused.");
        return;
      }
      setTrialIds(payload.data.ids as string[]);
      setTrialItems([]);
      setVerdict(null);
      setTrialStalled(false);
    })();
  }

  function activateDraftVersion() {
    if (!draftReason.trim()) {
      setActionError("A reason is required to activate a version.");
      return;
    }
    void runAction(async () => {
      const result = await postJson("/api/copywriter/prompts", {
        body: draftBody,
        model: draftModel,
        reason: draftReason.trim(),
        activate: true,
        trialIds: trialIds ?? undefined,
        activateAnyway: override,
      });
      if (result.ok) {
        setEditing(false);
        setTrialIds(null);
        setTrialItems([]);
        setVerdict(null);
        setOverride(false);
        setMetrics([]);
        fetch("/api/copywriter/metrics", { cache: "no-store" })
          .then((res) => res.json())
          .then((payload) => {
            if (payload?.success) setMetrics(payload.data.metrics as VersionMetrics[]);
          })
          .catch(() => {});
      }
      return result;
    });
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Link href="/settings" className="text-sm text-muted underline hover:text-foreground">
          ← Back to settings
        </Link>
        <div className="panel rounded p-6">
          <h1 className="text-base font-semibold">Prompt lab</h1>
          <p className="mt-2 text-sm text-muted">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!prompts) {
    return <div className="panel h-64 rounded" />;
  }

  const gateBlocked = verdict !== null && !verdict.gateOk && !override;
  const trialRunning =
    trialItems.length > 0 && trialItems.some((item) => item.status === "PENDING" || item.status === "CLAIMED");

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Prompt lab</h1>
          <p className="text-xs text-muted">
            Improve the AI campaign copy. Every change is a new version; revert is one click.
          </p>
        </div>
        <Link href="/settings" className="text-sm text-muted underline hover:text-foreground">
          ← Settings
        </Link>
      </div>

      {actionError && (
        <div role="alert" className="rounded border border-error/20 bg-error/10 p-3 text-sm text-error">
          {actionError}
        </div>
      )}

      {/* 1. Active prompt */}
      <section className="panel rounded p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Active prompt</h2>
          {canWrite && (
            <button
              type="button"
              onClick={startEditing}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
            >
              Edit prompt
            </button>
          )}
        </div>
        {active ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="rounded-full bg-accent/10 px-2.5 py-1 font-semibold text-accent">
                v{active.version}
              </span>
              <span>{active.authorEmail}</span>
              <span>{new Date(active.createdAt).toLocaleString()}</span>
              <span className="rounded border border-border px-2 py-0.5 uppercase">{active.model}</span>
            </div>
            <p className="text-sm text-foreground">{active.reason}</p>
            <PlaceholderBody body={active.body} />
          </div>
        ) : (
          <p className="text-sm text-muted">
            No prompt yet. The v1 seed is created on the first AI copy generation.
          </p>
        )}
      </section>

      {/* 6. Edit → test → activate */}
      {editing && active && canWrite && (
        <section className="panel rounded border border-accent/30 p-6">
          <h2 className="mb-4 text-base font-semibold">Draft version</h2>
          <div className="space-y-3">
            <textarea
              value={draftBody}
              onChange={(event) => {
                setDraftBody(event.target.value);
                if (trialIds) resetTrial();
              }}
              rows={16}
              className={`${inputClass} resize-y font-mono text-xs`}
            />
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted">
                {draftBody.length}/4000 characters
              </span>
              <select
                value={draftModel}
                onChange={(event) => {
                  setDraftModel(event.target.value as "haiku" | "sonnet");
                  if (trialIds) resetTrial();
                }}
                className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
              >
                <option value="haiku">haiku</option>
                <option value="sonnet">sonnet</option>
              </select>
              <input
                value={draftReason}
                onChange={(event) => setDraftReason(event.target.value)}
                placeholder="Reason (required)"
                className={`${inputClass} max-w-xs`}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={startTrial}
                disabled={busy || trialRunning}
                className="rounded border border-accent px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/5 disabled:opacity-50"
              >
                {trialRunning ? "Trial running…" : "Test on the last 5"}
              </button>
              <button
                type="button"
                onClick={activateDraftVersion}
                disabled={busy || gateBlocked}
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                Activate as v{(active.version ?? 0) + 1}
              </button>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(event) => setOverride(event.target.checked)}
                />
                Activate anyway (skip the trial gate)
              </label>
            </div>
            {trialStalled && (
              <p className="text-xs text-amber-400">
                Polling gave up after 60 s with generations still in flight.
                The run keeps going on the worker; run a new trial later to
                refresh the gate.
              </p>
            )}
            {verdict && !verdict.ready && !trialStalled && (
              <p className="text-xs text-amber-400">
                Trial still running — {verdict.trialPass}/{trialItems.length || 5} passed so far.
              </p>
            )}
            {verdict?.ready && (
              <p className={`text-xs ${verdict.gateOk ? "text-success" : "text-error"}`}>
                Trial lint pass {verdict.trialPass}/{trialItems.length} · active version{" "}
                {verdict.baselinePass}/{trialItems.length}
                {verdict.gateOk
                  ? " — the gate is satisfied."
                  : " — worse than the active version: use “Activate anyway” to record the override."}
              </p>
            )}
            {trialItems.length > 0 && (
              <div className="space-y-3">
                {trialItems.map((item) => {
                  const trialCopy = copyTexts(item.output);
                  const baselineCopy = copyTexts(item.baseline?.output);
                  const trialFacts = factsOfInput(item.input);
                  return (
                    <div key={item.id} className="rounded border border-border p-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                        <span className="font-medium text-foreground">
                          {trialFacts.sku ?? "—"} {trialFacts.title ?? ""}
                        </span>
                        <StateBadge status={item.status} />
                        {item.lintOk && <span className="text-success">lint OK</span>}
                        {!item.lintOk && item.status === "FAILED" && (
                          <span className="text-error">lint failed</span>
                        )}
                        {item.tier && <span>tier {item.tier}</span>}
                        {item.latencyMs !== null && <span>{item.latencyMs} ms</span>}
                      </div>
                      {item.status === "FAILED" && Array.isArray(item.lintErrors) && (
                        <ul className="mb-2 space-y-1">
                          {(item.lintErrors as Array<{ rule?: string; detail?: string }>).map(
                            (violation, i) => (
                              <li key={i} className="text-xs text-error">
                                {violation.rule}: {violation.detail}
                              </li>
                            )
                          )}
                        </ul>
                      )}
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="rounded bg-surface p-2">
                          <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">
                            Draft (v{item.promptVersion + 1} candidate)
                          </p>
                          {trialCopy ? (
                            <ul className="space-y-0.5 text-xs text-foreground">
                              <li>Opening DM: {trialCopy.openingDm ?? "—"}</li>
                              <li>Opening button: {trialCopy.openingButton ?? "—"}</li>
                              <li>Link DM: {trialCopy.revealDm}</li>
                              <li>Link button: {trialCopy.linkButton}</li>
                            </ul>
                          ) : (
                            <span className="text-xs text-muted">
                              {item.status === "FAILED" ? "No valid output" : "Waiting…"}
                            </span>
                          )}
                        </div>
                        <div className="rounded bg-surface p-2">
                          <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">
                            Active version, same input
                          </p>
                          {baselineCopy ? (
                            <ul className="space-y-0.5 text-xs text-foreground">
                              <li>Opening DM: {baselineCopy.openingDm ?? "—"}</li>
                              <li>Opening button: {baselineCopy.openingButton ?? "—"}</li>
                              <li>Link DM: {baselineCopy.revealDm}</li>
                              <li>Link button: {baselineCopy.linkButton}</li>
                            </ul>
                          ) : (
                            <span className="text-xs text-muted">No previous output</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 2. History */}
      <section className="panel rounded p-6">
        <h2 className="mb-4 text-base font-semibold">History</h2>
        <div className="space-y-2">
          {prompts.versions.map((version) => (
            <div
              key={version.id}
              className="flex flex-col gap-2 rounded border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  v{version.version}
                  {version.isActive && (
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                      active
                    </span>
                  )}
                  <span className="rounded border border-border px-1.5 py-0.5 text-xs uppercase text-muted">
                    {version.model}
                  </span>
                  <span className="text-xs font-normal text-muted">
                    {version.authorEmail} · {new Date(version.createdAt).toLocaleString()}
                  </span>
                </p>
                <p className="truncate text-xs text-muted">{version.reason}</p>
              </div>
              {canWrite && !version.isActive && (
                revertTarget?.id === version.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      value={revertReason}
                      onChange={(event) => setRevertReason(event.target.value)}
                      placeholder="Reason (required)"
                      className={`${inputClass} w-48`}
                    />
                    <button
                      type="button"
                      onClick={() => revertVersion(version)}
                      disabled={busy}
                      className="rounded bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setRevertTarget(null)}
                      className="text-xs text-muted underline"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setRevertTarget(version);
                      setRevertReason("");
                    }}
                    className="rounded border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
                  >
                    Revert to v{version.version}
                  </button>
                )
              )}
            </div>
          ))}
          {prompts.versions.length === 0 && (
            <p className="text-sm text-muted">No versions yet.</p>
          )}
        </div>
      </section>

      {/* 3. Metrics per version */}
      <section className="panel rounded p-6">
        <h2 className="mb-1 text-base font-semibold">Metrics per version</h2>
        <p className="mb-4 text-xs text-muted">
          Last 90 days, production generations only (trials excluded).
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-2 pr-3">Version</th>
                <th className="py-2 pr-3">Generations</th>
                <th className="py-2 pr-3">Lint pass (1st attempt)</th>
                <th className="py-2 pr-3">Repair rate</th>
                <th className="py-2 pr-3">Fallback rate</th>
                <th className="py-2 pr-3">Accepted without edit</th>
                <th className="py-2 pr-3">Median edit distance</th>
                <th className="py-2 pr-3">Median latency</th>
                <th className="py-2">Tier mix</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((row) => (
                <tr key={row.promptVersion} className="border-t border-border">
                  <td className="py-2 pr-3 font-medium text-foreground">v{row.promptVersion}</td>
                  <td className="py-2 pr-3 text-foreground">{row.generations}</td>
                  {row.enoughData ? (
                    <>
                      <td className="py-2 pr-3 text-foreground">
                        {row.lintPassFirstAttempt} (
                        {Math.round((row.lintPassFirstAttempt / row.generations) * 100)}
                        %)
                      </td>
                      <td className="py-2 pr-3 text-foreground">{Math.round(row.repairRate * 100)}%</td>
                      <td className="py-2 pr-3 text-foreground">{Math.round(row.fallbackRate * 100)}%</td>
                      <td className="py-2 pr-3 text-foreground">{row.acceptedWithoutEdit}</td>
                      <td className="py-2 pr-3 text-foreground">{row.medianEditDistance ?? "—"}</td>
                      <td className="py-2 pr-3 text-foreground">
                        {row.medianLatencyMs !== null ? `${row.medianLatencyMs} ms` : "—"}
                      </td>
                      <td className="py-2 text-foreground">
                        {Object.entries(row.tierMix)
                          .map(([tier, count]) => `${tier}×${count}`)
                          .join(", ") || "—"}
                      </td>
                    </>
                  ) : (
                    <td colSpan={7} className="py-2 text-muted">
                      Not enough data (below 5 generations)
                    </td>
                  )}
                </tr>
              ))}
              {metrics.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-3 text-muted">
                    No generations in the last 90 days.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 5. Golden examples */}
      <section className="panel rounded p-6">
        <h2 className="mb-1 text-base font-semibold">Golden examples</h2>
        <p className="mb-4 text-xs text-muted">
          At most 3. Each is rendered into the {"{{examples}}"} block. Adding or removing
          one creates a new version.
        </p>
        <div className="space-y-2">
          {examples.map((example, index) => (
            <div
              key={`${index}-${example.slice(0, 24)}`}
              className="flex items-start justify-between gap-3 rounded border border-border p-3"
            >
              <code className="whitespace-pre-wrap break-all text-xs text-muted">{example}</code>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => removeExample(index)}
                  disabled={busy}
                  className="shrink-0 rounded border border-error/20 px-2.5 py-1.5 text-xs font-medium text-error hover:bg-error/10 disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {examples.length === 0 && (
            <p className="text-sm text-muted">
              No golden example yet. Make one from a validated generation below, or from a
              campaign search.
            </p>
          )}
        </div>
        {canWrite && examples.length < 3 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <input
              value={campaignQuery}
              onChange={(event) => setCampaignQuery(event.target.value)}
              placeholder="Find a campaign by name or SKU…"
              className={`${inputClass} max-w-xs`}
              onKeyDown={(event) => {
                if (event.key === "Enter") searchCampaigns();
              }}
            />
            <button
              type="button"
              onClick={searchCampaigns}
              className="rounded border border-border px-3 py-1.5 text-sm font-medium text-muted hover:text-foreground"
            >
              Search
            </button>
            {campaignHits.length > 0 && (
              <div className="w-full space-y-1">
                {campaignHits.map((hit) => (
                  <div
                    key={hit.id}
                    className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2"
                  >
                    <span className="text-sm text-foreground">
                      {hit.name}
                      {hit.catnoTag && (
                        <span className="ml-2 text-xs text-muted">{hit.catnoTag}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => makeExampleFromCampaign(hit.id)}
                      disabled={busy}
                      className="rounded border border-accent px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/5 disabled:opacity-50"
                    >
                      Make it an example
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 4. Recent generations */}
      <section className="panel rounded p-6">
        <h2 className="mb-4 text-base font-semibold">Recent generations</h2>
        <div className="space-y-2">
          {generations.map((row) => {
            const output = copyTexts(row.output);
            const finalCopy = copyTexts(row.finalCopy);
            return (
              <div key={row.id} className="rounded border border-border p-3">
                <button
                  type="button"
                  onClick={() => setSelectedId(selectedId === row.id ? null : row.id)}
                  className="flex w-full flex-wrap items-center gap-2 text-left text-xs text-muted"
                >
                  <span className="font-medium text-foreground">
                    {row.facts.sku ?? "—"} · {row.facts.title ?? "—"}
                  </span>
                  <span>{row.facts.state ?? ""}</span>
                  <StateBadge status={row.status} />
                  <span>v{row.promptVersion}</span>
                  {row.campaignName && <span>campaign: {row.campaignName}</span>}
                  {row.editDistance !== null && <span>edit distance {row.editDistance}</span>}
                  <span className="ml-auto">{new Date(row.createdAt).toLocaleString()}</span>
                </button>
                {output && finalCopy && (
                  <div className="mt-2">
                    <CopyDiff output={output} final={finalCopy} />
                  </div>
                )}
                {canWrite && row.hasFinalCopy && examples.length < 3 && (
                  <button
                    type="button"
                    onClick={() => makeExample(row.id)}
                    disabled={busy}
                    className="mt-2 rounded border border-accent px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/5 disabled:opacity-50"
                  >
                    Make it an example
                  </button>
                )}
                {selectedId === row.id && (
                  <div className="mt-3 space-y-2 border-t border-border pt-3">
                    <div className="rounded bg-surface p-2 text-xs text-muted">
                      <p className="mb-1 font-medium text-foreground">Input facts</p>
                      <pre className="whitespace-pre-wrap">
                        {JSON.stringify(row.facts, null, 2)}
                      </pre>
                      {row.caption && (
                        <>
                          <p className="mb-1 mt-2 font-medium text-foreground">
                            Caption (truncated)
                          </p>
                          <p className="whitespace-pre-wrap">
                            {row.caption.length > 300 ? `${row.caption.slice(0, 300)}…` : row.caption}
                          </p>
                        </>
                      )}
                    </div>
                    <details className="rounded bg-surface p-2">
                      <summary className="cursor-pointer text-xs font-medium text-foreground">
                        Rendered prompt
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted">
                        {row.renderedPrompt}
                      </pre>
                    </details>
                  </div>
                )}
              </div>
            );
          })}
          {generations.length === 0 && (
            <p className="text-sm text-muted">No generation yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
