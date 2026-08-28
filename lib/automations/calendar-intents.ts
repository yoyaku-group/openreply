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
  return intent;
}

/** Parse "yoyaku=id,objects=id" without ever falling back across tenants. */
export function parseCalendarWorkspaceIds(raw = process.env.CALENDAR_WORKSPACE_IDS ?? "") {
  const result = new Map<"yoyaku" | "objects", string>();
  for (const pair of raw.split(",")) {
    const [key, id, ...extra] = pair.split("=").map((part) => part.trim());
    if (extra.length || !id || (key !== "yoyaku" && key !== "objects")) continue;
    result.set(key, id);
  }
  return result;
}

export function calendarCampaignName(intent: CalendarIntent): string {
  const subject = intent.release_skus[0] || intent.subject_key || intent.calendar_event_id;
  return `${subject} ${intent.cta_keyword} · Calendar`;
}
