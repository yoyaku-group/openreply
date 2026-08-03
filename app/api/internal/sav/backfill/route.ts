import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getConversationMessages, getConversations } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  boundSavContextMessages,
  ingestSavInboundEvent,
} from "@/lib/sav/service";
import {
  isSavEnabledAccount,
  savAccountKey,
} from "@/lib/sav/security";
import {
  requireSavBridge,
  savErrorResponse,
  savJson,
} from "@/lib/sav/http";

const bodySchema = z.object({
  orderReference: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9-]+$/),
  accountKey: z.string().trim().min(1).max(80).optional(),
});

function exactReferencePattern(reference: string): RegExp {
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-zA-Z0-9])${escaped}([^a-zA-Z0-9]|$)`, "i");
}

export async function POST(request: Request) {
  const unauthorized = requireSavBridge(request);
  if (unauthorized) return unauthorized;
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return savJson({ success: false, error: "INVALID_REQUEST" }, { status: 400 });
    }

    const accounts = (await prisma.instagramAccount.findMany({
      orderBy: { connectedAt: "asc" },
    })).filter(
      (account) =>
        isSavEnabledAccount(account.username) &&
        (!parsed.data.accountKey ||
          savAccountKey(account.username) === parsed.data.accountKey)
    );
    const pattern = exactReferencePattern(parsed.data.orderReference);

    for (const account of accounts) {
      const accessToken = decryptToken(account.accessToken);
      const conversations = (await getConversations(accessToken, account.instagramId)).slice(0, 50);
      for (const conversation of conversations) {
        const messages = (await getConversationMessages(accessToken, conversation.id)).slice(0, 20);
        if (!messages.some((message) => pattern.test(message.message ?? ""))) continue;

        // The old order reference identifies the thread; the latest inbound
        // determines the actionable item and the current 24-hour window.
        const latestInbound = messages
          .filter((message) => message.from?.id && message.from.id !== account.instagramId)
          .map((message) => ({ message, at: new Date(message.created_time ?? "") }))
          .filter(({ at }) => !Number.isNaN(at.getTime()))
          .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
        if (!latestInbound?.message.from?.id) continue;

        const senderId = latestInbound.message.from.id;
        const participant = conversation.participants?.data?.find(
          (entry) => entry.id === senderId
        );
        const contextMessages = boundSavContextMessages(
          messages.flatMap((message) => {
            const fromId = message.from?.id;
            const at = new Date(message.created_time ?? "");
            if (!fromId || Number.isNaN(at.getTime())) return [];
            return [{
              direction: fromId === account.instagramId
                ? ("OUTBOUND" as const)
                : ("INBOUND" as const),
              text: message.message ?? "",
              at: at.toISOString(),
              metaMessageId: message.id,
            }];
          })
        );
        const result = await ingestSavInboundEvent(
          {
            instagramAccountId: account.instagramId,
            senderInstagramId: senderId,
            senderUsername:
              latestInbound.message.from.username ?? participant?.username,
            conversationId: `${account.instagramId}:${senderId}`,
            metaMessageId: latestInbound.message.id,
            text: latestInbound.message.message ?? "",
            receivedAt: latestInbound.at,
            hasAttachments: false,
          },
          { graphConversationId: conversation.id, contextMessages }
        );
        return savJson({
          success: true,
          data: {
            found: true,
            imported: result.status === "created",
            itemId: result.id ?? null,
            accountKey: savAccountKey(account.username),
          },
        });
      }
    }

    return savJson({ success: true, data: { found: false, imported: false } });
  } catch (error) {
    return savErrorResponse(error);
  }
}
