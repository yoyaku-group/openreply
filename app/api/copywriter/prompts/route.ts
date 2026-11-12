import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CopywriterError } from "@/lib/copywriter/service";
import { labError, labJson, authorEmailFor, requireLabReader, requireLabWriter } from "@/lib/copywriter/lab-http";
import { canWriteLab } from "@/lib/copywriter/lab-access";
import {
  addGoldenExample,
  createPromptVersion,
  activateDraft,
  exampleFromCampaign,
  getPromptVersions,
  makeExampleFromGeneration,
  removeGoldenExample,
} from "@/lib/copywriter/lab";
import { prisma } from "@/lib/db/client";

// Read-your-writes for the lab; never cache.
export const dynamic = "force-dynamic";

/**
 * GET  /api/copywriter/prompts — every version plus the active one, and
 * whether the viewer may write (owners, or the documented allowlist
 * fallback when the workspace has no owner member).
 * POST /api/copywriter/prompts — one write surface for the lab: a new
 * version (optionally activated behind the trial gate), an example added or
 * removed (also a new version). Every failure carries a stable error code.
 * None of these writes touch a campaign.
 */

const createSchema = z.object({
  // body/model/reason are only demanded on the version branches; the
  // service-layer assertions turn a missing one into its stable 400 code.
  body: z.string().max(4000).optional(),
  model: z.enum(["haiku", "sonnet"]).optional(),
  reason: z.string().max(500).optional(),
  examples: z.array(z.string().min(1).max(4000)).max(3).optional(),
  activate: z.boolean().optional(),
  activateAnyway: z.boolean().optional(),
  trialIds: z.array(z.string().min(1).max(64)).max(5).optional(),
  addExample: z
    .object({
      generationId: z.string().min(1).max(64).optional(),
      automationId: z.string().min(1).max(64).optional(),
    })
    .optional(),
  removeExampleIndex: z.number().int().min(0).max(2).optional(),
});

type CreateInput = z.infer<typeof createSchema>;

/** The version branches need all three prompt fields; stable 400s otherwise. */
function requirePromptFields(input: CreateInput): {
  body: string;
  model: string;
  reason: string;
} {
  if (!input.body?.trim() || !input.model || !input.reason?.trim()) {
    throw new CopywriterError("INVALID_BODY", 400);
  }
  return { body: input.body, model: input.model, reason: input.reason };
}

export async function GET() {
  try {
    const guard = await requireLabReader();
    if (!guard.ok) return guard.response;
    const [{ versions, active }, canWrite] = await Promise.all([
      getPromptVersions(guard.context.workspaceId),
      canWriteLab(guard.context),
    ]);
    return labJson({
      success: true,
      data: { versions, active, canWrite },
    });
  } catch (error) {
    return labError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const guard = await requireLabWriter();
    if (!guard.ok) return guard.response;
    const { context } = guard;

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "INVALID_BODY", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const input = parsed.data;
    const authorEmail = await authorEmailFor(context.userId);

    if (input.addExample) {
      const { generationId, automationId } = input.addExample;
      if (Boolean(generationId) === Boolean(automationId)) {
        throw new CopywriterError("INVALID_BODY", 400);
      }
      const block = generationId
        ? await makeExampleFromGeneration(context.workspaceId, generationId)
        : await (async () => {
            const automation = await prisma.automation.findFirst({
              where: { id: automationId, workspaceId: context.workspaceId },
              select: {
                id: true,
                name: true,
                catnoTag: true,
                openingDmMessage: true,
                openingDmButtonLabel: true,
                dmMessage: true,
                linkButtonLabel: true,
              },
            });
            if (!automation) throw new CopywriterError("NOT_FOUND", 404);
            return exampleFromCampaign(automation);
          })();
      await addGoldenExample(context.workspaceId, block, authorEmail);
    } else if (typeof input.removeExampleIndex === "number") {
      await removeGoldenExample(context.workspaceId, input.removeExampleIndex, authorEmail);
    } else if (input.activate) {
      // New version activated in one transaction, behind the trial gate
      // unless the explicit override says otherwise (recorded in the reason).
      const fields = requirePromptFields(input);
      await activateDraft({
        workspaceId: context.workspaceId,
        body: fields.body,
        model: fields.model,
        reason: fields.reason,
        authorEmail,
        examples: input.examples,
        trialIds: input.trialIds,
        activateAnyway: input.activateAnyway,
      });
    } else {
      const fields = requirePromptFields(input);
      await createPromptVersion({
        workspaceId: context.workspaceId,
        body: fields.body,
        model: fields.model,
        reason: fields.reason,
        authorEmail,
        examples: input.examples,
        activate: false,
      });
    }

    const { versions, active } = await getPromptVersions(context.workspaceId);
    return labJson({ success: true, data: { versions, active } });
  } catch (error) {
    return labError(error);
  }
}
