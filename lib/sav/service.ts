import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { sendDirectMessage } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import type { WebhookMessageEvent } from "@/lib/meta/webhook";
import {
  createOpaqueToken,
  decryptSavText,
  encryptSavText,
  isSavEnabledAccount,
  sanitizeFailureCode,
  savAccountKey,
  savFingerprint,
  tokenHash,
} from "@/lib/sav/security";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const DELIVERY_TOKEN_MS = 5 * 60 * 1000;
const TERMINAL_RETENTION_MS = 7 * DAY_MS;
const PENDING_RETENTION_MS = 30 * DAY_MS;
const MAX_CLAIM_LIMIT = 20;
const HARD_MAX_SENDS_PER_HOUR = 10;
const DEFAULT_SENDS_PER_HOUR = HARD_MAX_SENDS_PER_HOUR;
// Database-wide transaction advisory lock namespace/id. Every SAV send must
// acquire this lock before counting and reserving a rolling-hour slot.
const SAV_SEND_CIRCUIT_LOCK_NAMESPACE = 0x534156;
const SAV_SEND_CIRCUIT_LOCK_ID = 1;
const CONTEXT_MAX_MESSAGES = 10;
const CONTEXT_MAX_CHARS = 20_000;
const CONTEXT_MAX_AGE_MS = 30 * DAY_MS;

export const SAV_ACCOUNT_KEY_TO_USERNAME = {
  yoyaku_fr: "yoyaku.fr",
  yoyakurecordstore: "yoyakurecordstore",
} as const;
export type SavAccountKey = keyof typeof SAV_ACCOUNT_KEY_TO_USERNAME;

export type SavPreflightStatus = "READY" | "WINDOW_EXPIRED" | "STALE_CONTEXT";
export type SavSendStatus =
  | "SENT"
  | "WINDOW_EXPIRED"
  | "STALE_CONTEXT"
  | "ALREADY_SENT";

export class SavBridgeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code);
    this.name = "SavBridgeError";
  }
}

export interface SavClaimItem {
  id: string;
  accountKey: string;
  accountUsername: string;
  accountInstagramId: string;
  senderInstagramId: string;
  senderUsername: string | null;
  conversationId: string;
  metaMessageId: string;
  text: string;
  contextMessages: SavContextMessage[];
  receivedAt: string;
  replyWindowExpiresAt: string;
  hasAttachments: boolean;
  claimToken: string;
}

export interface SavContextMessage {
  direction: "INBOUND" | "OUTBOUND";
  text: string;
  at: string;
  metaMessageId: string;
}

/** Keep the newest useful context, returned in chronological order. */
export function boundSavContextMessages(
  messages: SavContextMessage[],
  now = new Date()
): SavContextMessage[] {
  const cutoff = now.getTime() - CONTEXT_MAX_AGE_MS;
  const newestFirst = messages
    .filter((message) => {
      const timestamp = Date.parse(message.at);
      return (
        Number.isFinite(timestamp) &&
        timestamp >= cutoff &&
        timestamp <= now.getTime() + 5 * 60 * 1000 &&
        Boolean(message.metaMessageId)
      );
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, CONTEXT_MAX_MESSAGES);

  const selected: SavContextMessage[] = [];
  let remaining = CONTEXT_MAX_CHARS;
  for (const message of newestFirst) {
    if (remaining <= 0) break;
    const text = message.text.slice(0, remaining);
    selected.push({ ...message, text });
    remaining -= text.length;
  }
  return selected.reverse();
}

function encodedContext(messages: SavContextMessage[] | undefined): {
  ciphertext: string | null;
  fingerprint: string | null;
} {
  if (!messages?.length) return { ciphertext: null, fingerprint: null };
  const bounded = boundSavContextMessages(messages);
  if (!bounded.length) return { ciphertext: null, fingerprint: null };
  const serialized = JSON.stringify(bounded);
  return {
    ciphertext: encryptSavText(serialized),
    fingerprint: savFingerprint(serialized),
  };
}

function decodeContext(ciphertext: string): SavContextMessage[] {
  const parsed = JSON.parse(decryptSavText(ciphertext)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Invalid encrypted SAV context");
  const messages = parsed.flatMap((value): SavContextMessage[] => {
    if (!value || typeof value !== "object") return [];
    const entry = value as Record<string, unknown>;
    if (
      (entry.direction !== "INBOUND" && entry.direction !== "OUTBOUND") ||
      typeof entry.text !== "string" ||
      typeof entry.at !== "string" ||
      typeof entry.metaMessageId !== "string"
    ) {
      return [];
    }
    return [{
      direction: entry.direction,
      text: entry.text,
      at: entry.at,
      metaMessageId: entry.metaMessageId,
    }];
  });
  return boundSavContextMessages(messages);
}

function sendLimit(): number {
  const parsed = Number.parseInt(process.env.SAV_SENDS_PER_HOUR ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, HARD_MAX_SENDS_PER_HOUR)
    : DEFAULT_SENDS_PER_HOUR;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

export async function ingestSavInboundEvent(
  event: WebhookMessageEvent,
  options?: {
    graphConversationId?: string;
    contextMessages?: SavContextMessage[];
  }
): Promise<{ status: "created" | "duplicate" | "ignored"; id?: string }> {
  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: event.instagramAccountId },
    select: { id: true, workspaceId: true, instagramId: true, username: true },
  });
  if (!account || !isSavEnabledAccount(account.username)) {
    return { status: "ignored" };
  }

  const context = encodedContext(options?.contextMessages);
  const duplicate = await prisma.savTransportItem.findUnique({
    where: { metaMessageId: event.metaMessageId },
    select: { id: true },
  });
  if (duplicate) {
    if (options?.graphConversationId || context.ciphertext) {
      await prisma.savTransportItem.update({
        where: { id: duplicate.id },
        data: {
          graphConversationId: options?.graphConversationId,
          contextCiphertext: context.ciphertext ?? undefined,
          contextFingerprint: context.fingerprint ?? undefined,
          senderUsername: event.senderUsername,
        },
      });
    }
    return { status: "duplicate", id: duplicate.id };
  }

  const now = new Date();
  const receivedAt =
    event.receivedAt.getTime() > now.getTime() + 5 * 60 * 1000
      ? now
      : event.receivedAt;

  try {
    const item = await prisma.$transaction(async (tx) => {
      const racedDuplicate = await tx.savTransportItem.findUnique({
        where: { metaMessageId: event.metaMessageId },
        select: { id: true },
      });
      if (racedDuplicate) {
        if (options?.graphConversationId || context.ciphertext) {
          await tx.savTransportItem.update({
            where: { id: racedDuplicate.id },
            data: {
              graphConversationId: options?.graphConversationId,
              contextCiphertext: context.ciphertext ?? undefined,
              contextFingerprint: context.fingerprint ?? undefined,
              senderUsername: event.senderUsername,
            },
          });
        }
        return { id: racedDuplicate.id, created: false };
      }

      const currentFence = await tx.savConversationFence.findUnique({
        where: {
          instagramAccountId_senderInstagramId: {
            instagramAccountId: account.id,
            senderInstagramId: event.senderInstagramId,
          },
        },
        select: { revision: true, latestReceivedAt: true },
      });
      const isLatest =
        !currentFence || receivedAt.getTime() >= currentFence.latestReceivedAt.getTime();

      let revision: number;
      if (isLatest) {
        // Only the latest inbound in a conversation is actionable. Superseding
        // older work prevents duplicate Gmail reviews while preserving it for
        // the seven-day terminal audit window.
        await tx.savTransportItem.updateMany({
          where: {
            instagramAccountId: account.id,
            senderInstagramId: event.senderInstagramId,
            state: { in: ["PENDING", "CLAIMED", "REVIEWED"] },
          },
          data: {
            state: "HOLD",
            failureCode: "SUPERSEDED_BY_NEW_INBOUND",
            claimWorkerId: null,
            claimTokenHash: null,
            claimExpiresAt: null,
            deliveryTokenHash: null,
            deliveryTokenExpiresAt: null,
          },
        });

        const fence = await tx.savConversationFence.upsert({
          where: {
            instagramAccountId_senderInstagramId: {
              instagramAccountId: account.id,
              senderInstagramId: event.senderInstagramId,
            },
          },
          create: {
            instagramAccountId: account.id,
            senderInstagramId: event.senderInstagramId,
            revision: 1,
            latestMetaMessageId: event.metaMessageId,
            latestReceivedAt: receivedAt,
          },
          update: {
            revision: { increment: 1 },
            latestMetaMessageId: event.metaMessageId,
            latestReceivedAt: receivedAt,
          },
          select: { revision: true },
        });
        revision = fence.revision;
      } else {
        revision = currentFence.revision;
      }

      const created = await tx.savTransportItem.create({
        data: {
          workspaceId: account.workspaceId,
          instagramAccountId: account.id,
          accountInstagramId: account.instagramId,
          accountUsername: account.username,
          senderInstagramId: event.senderInstagramId,
          senderUsername: event.senderUsername,
          conversationKey: event.conversationId,
          graphConversationId: options?.graphConversationId,
          conversationRevision: revision,
          metaMessageId: event.metaMessageId,
          messageCiphertext: encryptSavText(event.text),
          messageFingerprint: savFingerprint(event.text),
          contextCiphertext: context.ciphertext,
          contextFingerprint: context.fingerprint,
          hasAttachments: event.hasAttachments,
          receivedAt,
          replyWindowExpiresAt: new Date(receivedAt.getTime() + DAY_MS),
          state: isLatest ? "PENDING" : "HOLD",
          failureCode: isLatest ? null : "OUT_OF_ORDER_INBOUND",
        },
        select: { id: true },
      });
      return { id: created.id, created: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return { status: item.created ? "created" : "duplicate", id: item.id };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await prisma.savTransportItem.findUnique({
        where: { metaMessageId: event.metaMessageId },
        select: { id: true },
      });
      if (existing && (options?.graphConversationId || context.ciphertext)) {
        await prisma.savTransportItem.update({
          where: { id: existing.id },
          data: {
            graphConversationId: options?.graphConversationId,
            contextCiphertext: context.ciphertext ?? undefined,
            contextFingerprint: context.fingerprint ?? undefined,
            senderUsername: event.senderUsername,
          },
        });
      }
      return { status: "duplicate", id: existing?.id };
    }
    throw error;
  }
}

export async function purgeExpiredSavTransport(now = new Date()): Promise<void> {
  await Promise.all([
    prisma.savTransportItem.deleteMany({
      where: {
        state: { in: ["SENT", "HOLD", "FAILED"] },
        updatedAt: { lt: new Date(now.getTime() - TERMINAL_RETENTION_MS) },
      },
    }),
    prisma.savTransportItem.deleteMany({
      where: {
        state: { in: ["PENDING", "CLAIMED", "REVIEWED", "SENDING"] },
        receivedAt: { lt: new Date(now.getTime() - PENDING_RETENTION_MS) },
      },
    }),
  ]);
}

export async function claimSavItems(
  workerId: string,
  requestedLimit: number,
  accountKeys?: SavAccountKey[]
): Promise<SavClaimItem[]> {
  const now = new Date();
  const limit = Math.max(1, Math.min(requestedLimit, MAX_CLAIM_LIMIT));
  await purgeExpiredSavTransport(now);

  const candidates = await prisma.savTransportItem.findMany({
    where: {
      accountUsername: {
        in: (accountKeys?.length
          ? accountKeys
          : (Object.keys(SAV_ACCOUNT_KEY_TO_USERNAME) as SavAccountKey[])
        ).map((key) => SAV_ACCOUNT_KEY_TO_USERNAME[key]),
      },
      OR: [
        { state: "PENDING" },
        { state: "CLAIMED", claimExpiresAt: { lte: now } },
      ],
    },
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
    take: limit * 3,
  });

  const claimed: SavClaimItem[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= limit) break;
    const claimToken = createOpaqueToken();
    const updated = await prisma.savTransportItem.updateMany({
      where: {
        id: candidate.id,
        OR: [
          { state: "PENDING" },
          { state: "CLAIMED", claimExpiresAt: { lte: now } },
        ],
      },
      data: {
        state: "CLAIMED",
        claimWorkerId: workerId,
        claimTokenHash: tokenHash(claimToken),
        claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (updated.count !== 1) continue;

    try {
      let contextMessages: SavContextMessage[];
      if (candidate.contextCiphertext) {
        contextMessages = decodeContext(candidate.contextCiphertext);
      } else {
        const contextItems = await prisma.savTransportItem.findMany({
          where: {
            instagramAccountId: candidate.instagramAccountId,
            senderInstagramId: candidate.senderInstagramId,
            receivedAt: {
              gte: new Date(now.getTime() - CONTEXT_MAX_AGE_MS),
              lte: candidate.receivedAt,
            },
          },
          orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
          take: CONTEXT_MAX_MESSAGES,
          select: {
            messageCiphertext: true,
            receivedAt: true,
            metaMessageId: true,
          },
        });
        contextMessages = boundSavContextMessages(
          contextItems.map((entry) => ({
            direction: "INBOUND" as const,
            text: decryptSavText(entry.messageCiphertext),
            at: entry.receivedAt.toISOString(),
            metaMessageId: entry.metaMessageId,
          })),
          now
        );
      }
      claimed.push({
        id: candidate.id,
        accountKey: savAccountKey(candidate.accountUsername),
        accountUsername: candidate.accountUsername,
        accountInstagramId: candidate.accountInstagramId,
        senderInstagramId: candidate.senderInstagramId,
        senderUsername: candidate.senderUsername,
        conversationId: candidate.graphConversationId ?? candidate.conversationKey,
        metaMessageId: candidate.metaMessageId,
        text: decryptSavText(candidate.messageCiphertext),
        contextMessages,
        receivedAt: candidate.receivedAt.toISOString(),
        replyWindowExpiresAt: candidate.replyWindowExpiresAt.toISOString(),
        hasAttachments: candidate.hasAttachments,
        claimToken,
      });
    } catch {
      await prisma.savTransportItem.updateMany({
        where: { id: candidate.id, state: "CLAIMED" },
        data: {
          state: "FAILED",
          failureCode: "DECRYPT_FAILED",
          claimTokenHash: null,
          claimExpiresAt: null,
        },
      });
    }
  }
  return claimed;
}

export async function markSavItemReviewed(
  id: string,
  claimToken: string
): Promise<void> {
  const now = new Date();
  const result = await prisma.savTransportItem.updateMany({
    where: {
      id,
      state: "CLAIMED",
      claimTokenHash: tokenHash(claimToken),
      claimExpiresAt: { gt: now },
    },
    data: {
      state: "REVIEWED",
      reviewedAt: now,
      claimWorkerId: null,
      claimTokenHash: null,
      claimExpiresAt: null,
      failureCode: null,
    },
  });
  if (result.count !== 1) throw new SavBridgeError("INVALID_CLAIM", 409);
}

async function finishSavItem(
  id: string,
  state: "HOLD" | "FAILED",
  claimToken: string | undefined,
  reason: unknown
): Promise<void> {
  const item = await prisma.savTransportItem.findUnique({ where: { id } });
  if (!item) throw new SavBridgeError("NOT_FOUND", 404);

  if (item.state === "CLAIMED") {
    if (
      !claimToken ||
      !item.claimExpiresAt ||
      item.claimExpiresAt <= new Date() ||
      item.claimTokenHash !== tokenHash(claimToken)
    ) {
      throw new SavBridgeError("INVALID_CLAIM", 409);
    }
  } else if (item.state !== "REVIEWED") {
    if (item.state === state) return;
    throw new SavBridgeError("INVALID_STATE", 409);
  }

  const updated = await prisma.savTransportItem.updateMany({
    where: { id, state: item.state },
    data: {
      state,
      failureCode: sanitizeFailureCode(reason),
      claimWorkerId: null,
      claimTokenHash: null,
      claimExpiresAt: null,
      deliveryTokenHash: null,
      deliveryTokenExpiresAt: null,
    },
  });
  if (updated.count !== 1) throw new SavBridgeError("CONCURRENT_UPDATE", 409);
}

export async function failSavItem(
  id: string,
  claimToken?: string,
  reason?: unknown
): Promise<void> {
  await finishSavItem(id, "FAILED", claimToken, reason ?? "WORKER_FAILED");
}

export async function holdSavItem(
  id: string,
  claimToken?: string,
  reason?: unknown
): Promise<void> {
  await finishSavItem(id, "HOLD", claimToken, reason ?? "HUMAN_HOLD");
}

export async function preflightSavItem(
  id: string,
  now = new Date()
): Promise<{ status: SavPreflightStatus; deliveryToken?: string; expiresAt?: string }> {
  const item = await prisma.savTransportItem.findUnique({ where: { id } });
  if (!item) throw new SavBridgeError("NOT_FOUND", 404);
  if (
    item.state === "HOLD" &&
    item.failureCode === "SUPERSEDED_BY_NEW_INBOUND"
  ) {
    return { status: "STALE_CONTEXT" };
  }
  if (item.state !== "REVIEWED") throw new SavBridgeError("INVALID_STATE", 409);
  if (item.replyWindowExpiresAt <= now) return { status: "WINDOW_EXPIRED" };

  const fence = await prisma.savConversationFence.findUnique({
    where: {
      instagramAccountId_senderInstagramId: {
        instagramAccountId: item.instagramAccountId,
        senderInstagramId: item.senderInstagramId,
      },
    },
    select: { revision: true },
  });
  if (!fence || fence.revision !== item.conversationRevision) {
    return { status: "STALE_CONTEXT" };
  }

  const deliveryToken = createOpaqueToken();
  const expiresAt = new Date(now.getTime() + DELIVERY_TOKEN_MS);
  const updated = await prisma.savTransportItem.updateMany({
    where: { id, state: "REVIEWED", conversationRevision: fence.revision },
    data: {
      deliveryTokenHash: tokenHash(deliveryToken),
      deliveryTokenExpiresAt: expiresAt,
    },
  });
  if (updated.count !== 1) throw new SavBridgeError("CONCURRENT_UPDATE", 409);
  return { status: "READY", deliveryToken, expiresAt: expiresAt.toISOString() };
}

export async function sendSavReply(input: {
  id: string;
  deliveryToken: string;
  idempotencyKey: string;
  text: string;
  now?: Date;
}): Promise<{ status: SavSendStatus; metaMessageId?: string }> {
  const now = input.now ?? new Date();
  const item = await prisma.savTransportItem.findUnique({
    where: { id: input.id },
    include: { instagramAccount: true },
  });
  if (!item) throw new SavBridgeError("NOT_FOUND", 404);
  if (
    item.state === "HOLD" &&
    item.failureCode === "SUPERSEDED_BY_NEW_INBOUND"
  ) {
    return { status: "STALE_CONTEXT" };
  }
  if (
    item.state === "SENT" ||
    item.state === "SENDING" ||
    (item.state === "FAILED" && item.deliveryIdempotencyKey)
  ) {
    return { status: "ALREADY_SENT", metaMessageId: item.metaReplyMessageId ?? undefined };
  }
  if (item.state !== "REVIEWED") throw new SavBridgeError("INVALID_STATE", 409);
  if (item.replyWindowExpiresAt <= now) return { status: "WINDOW_EXPIRED" };
  if (
    !item.deliveryTokenHash ||
    item.deliveryTokenHash !== tokenHash(input.deliveryToken) ||
    !item.deliveryTokenExpiresAt ||
    item.deliveryTokenExpiresAt <= now
  ) {
    throw new SavBridgeError("INVALID_DELIVERY_TOKEN", 409);
  }

  const gate = await prisma.$transaction(async (tx) => {
    const fence = await tx.savConversationFence.update({
      where: {
        instagramAccountId_senderInstagramId: {
          instagramAccountId: item.instagramAccountId,
          senderInstagramId: item.senderInstagramId,
        },
      },
      data: { revision: { increment: 0 } },
      select: { revision: true },
    });
    if (fence.revision !== item.conversationRevision) return "STALE_CONTEXT" as const;

    // Serialize the global count + reservation boundary across every app
    // process. A transaction isolation level alone cannot prevent two
    // different rows from both observing the last available slot.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(
      ${SAV_SEND_CIRCUIT_LOCK_NAMESPACE},
      ${SAV_SEND_CIRCUIT_LOCK_ID}
    )`;

    const attemptsLastHour = await tx.savTransportItem.count({
      where: {
        deliveryAttemptedAt: { gte: new Date(now.getTime() - HOUR_MS) },
      },
    });
    if (attemptsLastHour >= sendLimit()) {
      throw new SavBridgeError("CIRCUIT_OPEN", 429);
    }

    const updated = await tx.savTransportItem.updateMany({
      where: {
        id: item.id,
        state: "REVIEWED",
        conversationRevision: fence.revision,
        deliveryTokenHash: tokenHash(input.deliveryToken),
        deliveryTokenExpiresAt: { gt: now },
        deliveryAttemptedAt: null,
      },
      data: {
        state: "SENDING",
        deliveryIdempotencyKey: input.idempotencyKey,
        deliveryAttemptedAt: now,
        outboundFingerprint: savFingerprint(input.text),
      },
    });
    if (updated.count !== 1) return "ALREADY_SENT" as const;
    return "SEND" as const;
  });

  if (gate === "STALE_CONTEXT") return { status: "STALE_CONTEXT" };
  if (gate === "ALREADY_SENT") return { status: "ALREADY_SENT" };

  try {
    const result = await sendDirectMessage(
      decryptToken(item.instagramAccount.accessToken),
      item.accountInstagramId,
      item.senderInstagramId,
      input.text
    );
    await prisma.savTransportItem.updateMany({
      where: {
        id: item.id,
        state: "SENDING",
        deliveryIdempotencyKey: input.idempotencyKey,
      },
      data: {
        state: "SENT",
        metaReplyMessageId: result.message_id,
        sentAt: new Date(),
        deliveryTokenHash: null,
        deliveryTokenExpiresAt: null,
      },
    });
    return { status: "SENT", metaMessageId: result.message_id };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? `META_${String(error.code)}`
        : "META_SEND_UNCERTAIN";
    await prisma.savTransportItem.updateMany({
      where: {
        id: item.id,
        state: "SENDING",
        deliveryIdempotencyKey: input.idempotencyKey,
      },
      data: {
        state: "FAILED",
        failureCode: sanitizeFailureCode(code),
        deliveryTokenHash: null,
        deliveryTokenExpiresAt: null,
      },
    });
    throw new SavBridgeError("META_SEND_FAILED", 502);
  }
}

export async function getSavBridgeHealth(): Promise<Record<string, number | string>> {
  const [pending, claimed, reviewed, sending] = await Promise.all([
    prisma.savTransportItem.count({ where: { state: "PENDING" } }),
    prisma.savTransportItem.count({ where: { state: "CLAIMED" } }),
    prisma.savTransportItem.count({ where: { state: "REVIEWED" } }),
    prisma.savTransportItem.count({ where: { state: "SENDING" } }),
  ]);
  return {
    status: "ok",
    pending,
    claimed,
    reviewed,
    sending,
    timestamp: new Date().toISOString(),
  };
}
