import { createHash, createHmac, randomBytes } from "crypto";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateDigest(value: string): string {
  const secret =
    process.env.FACEBOOK_APP_SECRET ?? process.env.INSTAGRAM_APP_SECRET;
  if (!secret) throw new Error("Meta app secret is required");
  return createHmac("sha256", secret).update(value).digest("hex");
}

function confirmationCode(): string {
  return randomBytes(24).toString("base64url");
}

const accountSelector = (platformUserId: string) => ({
  where: {
    OR: [
      { instagramScopedId: platformUserId },
      { instagramId: platformUserId },
    ],
  },
  select: {
    id: true,
    workspaceId: true,
    username: true,
    instagramId: true,
    instagramScopedId: true,
  },
});

async function deleteAccountMetaData(
  tx: Prisma.TransactionClient,
  account: {
    id: string;
    instagramId: string;
    instagramScopedId: string | null;
  },
): Promise<void> {
  // Historical WebhookEvent rows predate a direct account FK. Remove any
  // redacted payload containing either exact Meta identifier before deleting
  // the connected account. jsonb_path_exists compares JSON scalar values, not
  // substrings, so another account cannot be swept by a partial ID match.
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM "WebhookEvent"
    WHERE jsonb_path_exists(
      "payload",
      '$.** ? (@ == $accountId)',
      jsonb_build_object('accountId', to_jsonb(${account.instagramId}::text))
    )
    OR (
      ${account.instagramScopedId}::text IS NOT NULL
      AND jsonb_path_exists(
        "payload",
        '$.** ? (@ == $scopedId)',
        jsonb_build_object('scopedId', to_jsonb(${account.instagramScopedId}::text))
      )
    )
  `);
  await tx.processedComment.deleteMany({
    where: { instagramAccountId: account.id },
  });
  await tx.instagramAccount.delete({ where: { id: account.id } });
}

export async function processMetaDeauthorization(
  platformUserId: string,
): Promise<{ disconnected: boolean }> {
  return prisma.$transaction(async (tx) => {
    const account = await tx.instagramAccount.findFirst(
      accountSelector(platformUserId),
    );
    if (account) {
      await deleteAccountMetaData(tx, account);
    }
    await tx.operationalEvent.create({
      data: {
        workspaceId: account?.workspaceId ?? null,
        source: "SYSTEM",
        level: "INFO",
        message: "Meta deauthorization callback processed",
        payload: {
          disconnected: Boolean(account),
          accountFingerprint: privateDigest(platformUserId).slice(0, 16),
        },
      },
    });
    return { disconnected: Boolean(account) };
  });
}

export interface MetaDataDeletionReceipt {
  confirmationCode: string;
  status: string;
  requestedAt: Date;
  completedAt: Date | null;
}

export async function processMetaDataDeletionRequest(args: {
  platformUserId: string;
  signedRequest: string;
}): Promise<MetaDataDeletionReceipt> {
  const requestFingerprint = digest(args.signedRequest);
  const existing = await prisma.metaDataDeletionRequest.findUnique({
    where: { requestFingerprint },
  });
  if (existing) return existing;

  try {
    return await prisma.$transaction(async (tx) => {
      const account = await tx.instagramAccount.findFirst(
        accountSelector(args.platformUserId),
      );
      const receipt = await tx.metaDataDeletionRequest.create({
        data: {
          confirmationCode: confirmationCode(),
          requestFingerprint,
          platformUserIdHash: privateDigest(args.platformUserId),
          matchedUsername: account?.username ?? null,
          status: "PROCESSING",
        },
      });

      if (account) {
        await deleteAccountMetaData(tx, account);
      }

      const completedAt = new Date();
      await tx.metaDataDeletionRequest.update({
        where: { id: receipt.id },
        data: {
          status: "COMPLETED",
          completedAt,
          // The username is only useful while resolving the request and is
          // cleared with the rest of the Instagram-derived account data.
          matchedUsername: null,
        },
      });
      return {
        confirmationCode: receipt.confirmationCode,
        status: "COMPLETED",
        requestedAt: receipt.requestedAt,
        completedAt,
      };
    });
  } catch (error) {
    // Concurrent retries can race on the unique request fingerprint. Return
    // the winning receipt instead of turning a valid Meta retry into a 500.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const receipt = await prisma.metaDataDeletionRequest.findUnique({
        where: { requestFingerprint },
      });
      if (receipt) return receipt;
    }
    throw error;
  }
}
