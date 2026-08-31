import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import {
  parseCommentEvents,
  parseMessageEvents,
  parsePostbackEvents,
  parseReadEvents,
  verifyWebhookSignature,
} from "@/lib/meta/webhook";
import {
  INBOUND_MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
} from "@/lib/queue/client";
import { Prisma } from "@/app/generated/prisma/client";
import { ingestSavInboundEvent } from "@/lib/sav/service";
import { matchInboundDmAutomations } from "@/lib/automations/inbound-dm";
import { publicFingerprint, redactWebhookPayload } from "@/lib/sav/security";
import { recordInstagramWebhookCapability } from "@/lib/meta/capabilities";

const OPENING_DM_READ_FALLBACK_DELAY_MS = 5 * 60 * 1000;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 },
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature)) {
    // Record the attempt so a signature mismatch is visible rather than a
    // silent 401. This is the common symptom of FACEBOOK_APP_SECRET being
    // set to the wrong app's secret for the webhook's signing key.
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "WARNING",
          message: "Webhook signature verification failed",
          payload: {
            hadSignatureHeader: Boolean(signature),
            bodyLength: rawBody.length,
            bodyFingerprint: publicFingerprint(rawBody).slice(0, 16),
          },
        },
      })
      .catch(() => {});
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      object:
        typeof payload === "object" && payload && "object" in payload
          ? String(payload.object)
          : null,
      payload: redactWebhookPayload(payload) as Prisma.InputJsonValue,
      status: "PENDING",
    },
  });

  try {
    const commentEvents = parseCommentEvents(
      payload as Parameters<typeof parseCommentEvents>[0],
    );
    const queue = getDMQueue();

    // Exact inbound-DM campaign commands are classified before SAV. A unique
    // match goes to the DM worker; normal messages and ambiguous matches stay
    // on the existing encrypted SAV path.
    const messageEvents = parseMessageEvents(
      payload as Parameters<typeof parseMessageEvents>[0],
    );
    for (const event of messageEvents) {
      const account = await prisma.instagramAccount.findUnique({
        where: { instagramId: event.instagramAccountId },
        select: { id: true, workspaceId: true },
      });
      const inboundCampaigns = account
        ? await prisma.automation.findMany({
            where: {
              instagramAccountId: account.id,
              triggerType: "INBOUND_DM",
              isActive: true,
            },
            select: { id: true, keywords: true },
            orderBy: { createdAt: "asc" },
          })
        : [];
      const matches = matchInboundDmAutomations(
        inboundCampaigns,
        event.text,
        event.hasAttachments,
      );

      if (matches.length === 1) {
        const match = matches[0];
        await queue.add(
          INBOUND_MESSAGE_JOB_NAME,
          {
            instagramAccountId: event.instagramAccountId,
            senderInstagramId: event.senderInstagramId,
            senderUsername: event.senderUsername,
            metaMessageId: event.metaMessageId,
            text: event.text,
            hasAttachments: event.hasAttachments,
            receivedAt: event.receivedAt.toISOString(),
            automationId: match.automation.id,
            matchedKeyword: match.matchedKeyword,
          },
          {
            jobId: `inbound_${event.instagramAccountId}_${event.senderInstagramId}_${match.automation.id}_${event.metaMessageId.replace(/:/g, "_")}`,
          },
        );
      } else {
        if (matches.length > 1) {
          await prisma.operationalEvent.create({
            data: {
              workspaceId: account?.workspaceId ?? null,
              source: "SYSTEM",
              level: "WARNING",
              message:
                "Inbound Instagram DM matched multiple active campaigns; auto-send blocked",
              payload: {
                instagramAccountId: event.instagramAccountId,
                metaMessageId: event.metaMessageId,
                automationIds: matches.map((match) => match.automation.id),
                normalizedKeyword: matches[0].normalizedKeyword,
              },
            },
          });
        }
        await ingestSavInboundEvent(event);
      }

      if (account) {
        await recordInstagramWebhookCapability(account.id, "MESSAGES").catch(
          (error) =>
            console.warn(
              "[Instagram Webhook] failed to record message capability:",
              error,
            ),
        );
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }
    }

    for (const event of commentEvents) {
      const account = await prisma.instagramAccount.findUnique({
        where: { instagramId: event.instagramAccountId },
        select: { id: true, workspaceId: true },
      });

      await queue.add(
        "process-comment",
        {
          instagramAccountId: event.instagramAccountId,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          source: "WEBHOOK",
        },
        {
          jobId: `comment_${event.instagramAccountId}_${event.commentId}`,
        },
      );

      if (account) {
        await recordInstagramWebhookCapability(account.id, "COMMENTS").catch(
          (error) =>
            console.warn(
              "[Instagram Webhook] failed to record comment capability:",
              error,
            ),
        );
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }
    }

    // Button taps from opening DMs → deliver the reveal message.
    const postbackEvents = parsePostbackEvents(
      payload as Parameters<typeof parsePostbackEvents>[0],
    );

    for (const event of postbackEvents) {
      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          userId: event.userId,
          payload: event.payload,
          mid: event.mid,
        },
        {
          // BullMQ forbids ":" in custom job ids, and the payload is
          // "reveal:<id>", so build with underscores and strip any colons.
          jobId: `postback_${event.instagramAccountId}_${event.userId}_${(
            event.mid ?? event.payload
          ).replace(/:/g, "_")}`,
        },
      );
    }

    // If a user reads the opening DM and never taps the button, deliver the
    // same next-step DM after five minutes. The worker no-ops this delayed job
    // if a real button tap has already delivered the reveal.
    const readEvents = parseReadEvents(
      payload as Parameters<typeof parseReadEvents>[0],
    );

    for (const event of readEvents) {
      const openingLogs = await prisma.dmLog.findMany({
        where: {
          commenterId: event.userId,
          status: "SENT",
          automation: {
            isActive: true,
            openingDmEnabled: true,
            instagramAccount: {
              instagramId: event.instagramAccountId,
            },
          },
        },
        select: {
          automation: {
            select: {
              id: true,
            },
          },
        },
      });

      const scheduledAutomationIds = new Set<string>();
      for (const log of openingLogs) {
        const automation = log.automation;
        if (scheduledAutomationIds.has(automation.id)) continue;
        scheduledAutomationIds.add(automation.id);

        await queue.add(
          POSTBACK_JOB_NAME,
          {
            instagramAccountId: event.instagramAccountId,
            userId: event.userId,
            payload: `reveal:${automation.id}`,
            fallback: true,
          },
          {
            delay: OPENING_DM_READ_FALLBACK_DELAY_MS,
            jobId: `read_fallback_${event.instagramAccountId}_${event.userId}_${automation.id}`,
          },
        );
      }
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch {
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "FAILED",
        errorMessage: "WEBHOOK_PROCESSING_FAILED",
        processedAt: new Date(),
      },
    });

    return NextResponse.json(
      { success: false, error: "Webhook processing failed" },
      { status: 500 },
    );
  }
}
