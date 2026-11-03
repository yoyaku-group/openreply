import { z } from "zod";
import { parseCatnoTag } from "@/lib/automations/catalogue";

/**
 * The campaign payload contract, shared by the dashboard route and any script
 * that has to write a campaign outside an HTTP request. Extracted from
 * `app/api/automations/route.ts` unchanged so there is exactly one copy of the
 * field list and its limits (rules/81: one SSOT, no duplicated mapping).
 */

export const triggerTypeSchema = z.enum(["COMMENT", "INBOUND_DM"]);

/**
 * `catnoTag` is the Instagram hashtag that identifies a future publication
 * (e.g. `#ABC001`). Exterior whitespace and one optional leading `#` are
 * accepted; the stored value is canonical upper-case without the `#`. Invalid
 * internal punctuation is rejected rather than silently removed.
 */
export const catnoTagSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  },
  z
    .string()
    .max(51)
    .superRefine((value, ctx) => {
      const parsed = parseCatnoTag(value);
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", message: parsed.message });
      }
    })
    .transform((value) => {
      const parsed = parseCatnoTag(value);
      return parsed.ok ? parsed.value : value;
    })
    .nullable()
    .optional(),
);

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(100),
  goal: z.string().min(1).max(120).optional().nullable(),
  instagramAccountId: z.string().min(1).optional().nullable(),
  triggerType: triggerTypeSchema.optional().default("COMMENT"),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  pendingNextReel: z.boolean().optional().default(false),
  matchAnyPost: z.boolean().optional().default(false),
  catnoTag: catnoTagSchema,
  keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
  matchAnyWord: z.boolean().optional().default(false),
  dmMessage: z.string().min(1).max(1000),
  openingDmEnabled: z.boolean().optional().default(false),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(20).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional().default(false),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional().default(false),
  followUpMessage: z.string().max(1000).optional().nullable(),
  publicReplyEnabled: z.boolean().optional().default(false),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z
    .array(z.string().max(1000))
    .max(10)
    .optional()
    .default([]),
  // Empty string means "no tracked link"; a URL sets one.
  trackedDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  // Optional second tracked link, rendered as a second DM button.
  secondaryDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
  isActive: z.boolean().optional().default(true),
  wholeWordMatch: z.boolean().optional().default(true),
});

export const updateAutomationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).max(120).optional().nullable(),
  triggerType: triggerTypeSchema.optional(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  pendingNextReel: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  catnoTag: catnoTagSchema,
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  matchAnyWord: z.boolean().optional(),
  dmMessage: z.string().min(1).max(1000).optional(),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(20).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
  // Empty string clears the tracked link; a URL updates/creates it; undefined
  // leaves it unchanged.
  trackedDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  // Same semantics for the optional second tracked link / DM button.
  secondaryDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
});

export type TriggerType = z.infer<typeof triggerTypeSchema>;
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;
