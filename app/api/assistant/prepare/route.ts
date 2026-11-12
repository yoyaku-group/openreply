import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveProduct, isPurchasableState } from "@/lib/assistant/resolve-product";
import { composeCaption } from "@/lib/assistant/caption";
import { ctaFor } from "@/lib/assistant/caption-cta";
import { generateCopy } from "@/lib/assistant/generate-copy";
import { enqueueGeneration, storedCopyFromCampaignCopy } from "@/lib/copywriter/service";
import {
  findPendingCatalogueConflict,
  findUnboundCalendarConflict,
} from "@/lib/automations/catalogue";
import { campaignStatus } from "@/lib/automations/status";
import { prisma } from "@/lib/db/client";
import {
  canManageCampaigns,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// Read-your-writes for the existing-campaign lookup; never cache.
export const dynamic = "force-dynamic";

/**
 * Campaign assistant: resolve a product (URL or SKU) into campaign-ready
 * facts, compose the caption, generate the DM copy, and report an existing
 * campaign for the same catalogue reference.
 *
 * The route ONLY reads: it never creates or updates a campaign — saving and
 * validating go through the normal `POST`/`PATCH /api/automations`.
 */

const prepareSchema = z.object({
  product: z.string().min(1).max(500),
  caption: z.string().max(5000).optional(),
  instagramAccountId: z.string().min(1).optional(),
});

function prepareErrorResponse(
  code: string,
  message: string,
  status: number,
) {
  return NextResponse.json(
    { success: false, code, error: message },
    { status },
  );
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  if (!canManageCampaigns(context.role)) {
    return NextResponse.json(
      {
        success: false,
        error: "Only editors, admins, and owners can prepare campaigns",
      },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // An empty or malformed body is a client error, not a 500.
    return prepareErrorResponse(
      "PRODUCT_URL_INVALID",
      "Invalid JSON body.",
      400,
    );
  }
  const parsed = prepareSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        code: "PRODUCT_URL_INVALID",
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  // Same account resolution as the campaign builder: the named account when
  // it belongs to the workspace, otherwise the most recently connected one.
  const requestedAccountId =
    parsed.data.instagramAccountId &&
    parsed.data.instagramAccountId !== "all"
      ? parsed.data.instagramAccountId
      : null;
  const instagramAccount = requestedAccountId
    ? await prisma.instagramAccount.findFirst({
        where: { id: requestedAccountId, workspaceId: context.workspaceId },
      })
    : await prisma.instagramAccount.findFirst({
        where: { workspaceId: context.workspaceId },
        orderBy: { connectedAt: "desc" },
      });

  const resolved = await resolveProduct(parsed.data.product);
  if (!resolved.ok) {
    const status =
      resolved.code === "PRODUCT_NOT_FOUND"
        ? 404
        : resolved.code === "PRODUCT_URL_INVALID"
          ? 400
          : 502;
    return prepareErrorResponse(resolved.code, resolved.message, status);
  }

  const facts = resolved.facts;
  const caption = composeCaption({
    caption: parsed.data.caption,
    facts,
    cta: ctaFor(facts.state),
  });
  const copy = generateCopy(facts, parsed.data.caption);

  // The AI copywriter queue (default off). Only buyable products are
  // enqueueable: for coming_soon and sold_out the truthful standard copy and
  // its draft-only gate stay. The response never waits on the queue — the
  // page polls the status route.
  const generationId =
    copy.ok && isPurchasableState(facts.state)
      ? await enqueueGeneration({
          workspaceId: context.workspaceId,
          facts,
          caption: parsed.data.caption ?? null,
          standardCopy: storedCopyFromCampaignCopy(copy.copy),
        })
      : null;

  // A campaign already prepared for this reference on this account: a waiting
  // catalogue campaign or draft (the ref-conflict query), or an unbound
  // Calendar / release-sync campaign. Same normalized comparison the save
  // API enforces, so what the assistant reports is what the API will accept.
  let existingCampaign: {
    id: string;
    name: string;
    status: string;
    source: string;
  } | null = null;
  if (facts.catnoTag && instagramAccount) {
    const conflict =
      (await findPendingCatalogueConflict(
        { instagramAccountId: instagramAccount.id, catnoTag: facts.catnoTag },
        prisma,
      )) ??
      (await findUnboundCalendarConflict(
        { instagramAccountId: instagramAccount.id, catnoTag: facts.catnoTag },
        prisma,
      ));
    if (conflict) {
      existingCampaign = {
        id: conflict.id,
        name: conflict.name,
        status: campaignStatus(conflict).label,
        source: conflict.source,
      };
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      facts,
      caption,
      copy,
      lint: copy.ok ? copy.lint : null,
      // The page blocks "Validate for publication" (drafts only) while this
      // is false: a coming-soon or sold-out product cannot be bought yet.
      checks: { purchasable: isPurchasableState(facts.state) },
      existingCampaign,
      generationId,
    },
  });
}
