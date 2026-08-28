import { z } from "zod";

const HTTPS_URL = z.string().url().refine((value) => value.startsWith("https://"));

const calendarIntentSchema = z.object({
  publication_key: z.string().min(3).max(200),
  calendar_event_id: z.string().min(1).max(256),
  workspace_key: z.enum(["yoyaku", "objects"]),
  account_owner: z.string().min(2).max(80),
  publication_kind: z.string().max(80),
  subject_key: z.string().max(160).nullable().optional(),
  release_skus: z.array(z.string().min(1).max(64)).max(20).default([]),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  cta_keyword: z.string().min(1).max(50),
  caption_draft: z.string().max(2200).nullable().optional(),
  destination_url: HTTPS_URL,
  assets_url: HTTPS_URL.nullable().optional(),
  published_url: HTTPS_URL.nullable().optional(),
  external_id: z.string().max(160).nullable().optional(),
  status: z.string().max(40),
  automation_status: z.string().max(40),
  updated_at: z.string().datetime({ offset: true }).optional(),
});

export type CalendarIntent = z.infer<typeof calendarIntentSchema>;

const CTA_BY_WORKSPACE: Record<CalendarIntent["workspace_key"], ReadonlySet<string>> = {
  yoyaku: new Set(["LINK", "VINYL", "BACK", "TICKETS"]),
  objects: new Set(["PRESSING", "QUOTE", "DEVIS"]),
};

const DEFAULT_DESTINATION_DOMAINS: Record<CalendarIntent["workspace_key"], string[]> = {
  yoyaku: ["yoyaku.io", "yoyaku.fr", "yy.link", "shotgun.live"],
  objects: ["objects.press"],
};

function destinationDomains(workspaceKey: CalendarIntent["workspace_key"]): string[] {
  const configured = String(
    process.env[`CALENDAR_DESTINATION_HOSTS_${workspaceKey.toUpperCase()}`] || ""
  )
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...DEFAULT_DESTINATION_DOMAINS[workspaceKey], ...configured])];
}

function destinationAllowed(url: string, workspaceKey: CalendarIntent["workspace_key"]): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return destinationDomains(workspaceKey).some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
}

export function normalizeCalendarIntent(value: unknown): CalendarIntent | null {
  const parsed = calendarIntentSchema.safeParse(value);
  if (!parsed.success) return null;
  const intent = {
    ...parsed.data,
    account_owner: parsed.data.account_owner.toLowerCase(),
    cta_keyword: parsed.data.cta_keyword.toUpperCase(),
    release_skus: parsed.data.release_skus.map((sku) => sku.toUpperCase()),
  };
  if (!CTA_BY_WORKSPACE[intent.workspace_key].has(intent.cta_keyword)) return null;
  const expectedSender = intent.workspace_key === "objects" ? "objects.press" : "yoyakurecordstore";
  if (intent.account_owner !== expectedSender) return null;
  if (!destinationAllowed(intent.destination_url, intent.workspace_key)) return null;
  return intent;
}

/** Parse "yoyaku=id,objects=id" without ever falling back across tenants. */
export function parseCalendarWorkspaceIds(raw = process.env.CALENDAR_WORKSPACE_IDS ?? "") {
  const result = new Map<"yoyaku" | "objects", string>();
  for (const pair of raw.split(",")) {
    const [key, id, ...extra] = pair.split("=").map((part) => part.trim());
    if (
      extra.length ||
      !/^[a-zA-Z0-9_-]{10,}$/.test(id || "") ||
      /change[_-]?me/i.test(id) ||
      (key !== "yoyaku" && key !== "objects")
    ) continue;
    result.set(key, id);
  }
  return result;
}

export function calendarAutomationUpdateState(
  existing: {
    isActive: boolean;
    postId: string | null;
    keywords: string[];
    destinationUrl: string | null;
  },
  intent: CalendarIntent
) {
  const postId = intent.external_id || null;
  const materialChanged =
    (existing.isActive && !postId) ||
    existing.postId !== postId ||
    existing.keywords.length !== 1 ||
    existing.keywords[0] !== intent.cta_keyword ||
    existing.destinationUrl !== intent.destination_url;
  const isActive = existing.isActive && !materialChanged;
  return {
    isActive,
    lifecycle: isActive ? "ACTIVE" : postId ? "READY" : "PLANNED",
    materialChanged,
  } as const;
}

export function calendarCampaignName(intent: CalendarIntent): string {
  const subject = intent.release_skus[0] || intent.subject_key || intent.calendar_event_id;
  return `${subject} ${intent.cta_keyword} · Calendar`;
}
