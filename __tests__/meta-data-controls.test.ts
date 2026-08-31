import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => {
  const transactionClient = {
    instagramAccount: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    processedComment: { deleteMany: vi.fn() },
    $executeRaw: vi.fn(),
    metaDataDeletionRequest: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    operationalEvent: { create: vi.fn() },
  };
  return {
    mockPrisma: {
      ...transactionClient,
      $transaction: vi.fn(
        async (callback: (tx: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { GET as getDeauthorize, POST as postDeauthorize } from "@/app/api/instagram/deauthorize/route";
import { GET as getDataDeletion, POST as postDataDeletion } from "@/app/api/instagram/data-deletion/route";
import { GET as getDeletionStatus } from "@/app/api/instagram/data-deletion/[code]/route";
import { verifyMetaSignedRequest } from "@/lib/meta/signed-request";

const SECRET = "facebook-app-secret";

function signedRequest(payload: Record<string, unknown>, secret = SECRET) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${signature}.${encodedPayload}`;
}

function callbackRequest(path: string, value: string) {
  return new Request(`https://openreply.yoyaku.fr${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ signed_request: value }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FACEBOOK_APP_SECRET", SECRET);
  vi.stubEnv("INSTAGRAM_APP_SECRET", "instagram-app-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://openreply.yoyaku.fr");
  mockPrisma.metaDataDeletionRequest.findUnique.mockResolvedValue(null);
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "account_1",
    workspaceId: "workspace_1",
    username: "reviewer.test",
    instagramId: "professional_1",
    instagramScopedId: "app_scoped_1",
  });
  mockPrisma.instagramAccount.delete.mockResolvedValue({ id: "account_1" });
  mockPrisma.metaDataDeletionRequest.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "deletion_1",
      ...data,
    }),
  );
  mockPrisma.metaDataDeletionRequest.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "deletion_1",
      ...data,
    }),
  );
  mockPrisma.operationalEvent.create.mockResolvedValue({});
});

describe("Meta signed request verification", () => {
  it("accepts a valid HMAC-SHA256 payload and rejects tampering", () => {
    const value = signedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "app_scoped_1",
      issued_at: 1_788_196_800,
    });

    expect(verifyMetaSignedRequest(value)).toMatchObject({
      userId: "app_scoped_1",
      algorithm: "HMAC-SHA256",
    });
    expect(verifyMetaSignedRequest(`${value}tampered`)).toBeNull();
  });

  it("fails closed on an unsupported algorithm or missing user id", () => {
    expect(
      verifyMetaSignedRequest(
        signedRequest({ algorithm: "HMAC-SHA1", user_id: "user_1" }),
      ),
    ).toBeNull();
    expect(
      verifyMetaSignedRequest(signedRequest({ algorithm: "HMAC-SHA256" })),
    ).toBeNull();
  });
});

describe("Meta data controls", () => {
  it("exposes public readiness GETs without accepting an unsigned deletion", async () => {
    expect((await getDeauthorize()).status).toBe(200);
    expect((await getDataDeletion()).status).toBe(200);

    const response = await postDataDeletion(
      callbackRequest("/api/instagram/data-deletion", "invalid") as never,
    );
    expect(response.status).toBe(401);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("deauthorizes only the account resolved from a valid signed request", async () => {
    const response = await postDeauthorize(
      callbackRequest(
        "/api/instagram/deauthorize",
        signedRequest({
          algorithm: "HMAC-SHA256",
          user_id: "app_scoped_1",
        }),
      ) as never,
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { instagramScopedId: "app_scoped_1" },
          { instagramId: "app_scoped_1" },
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
    expect(mockPrisma.instagramAccount.delete).toHaveBeenCalledWith({
      where: { id: "account_1" },
    });
  });

  it("deletes the matching Instagram data and returns Meta's receipt contract", async () => {
    const response = await postDataDeletion(
      callbackRequest(
        "/api/instagram/data-deletion",
        signedRequest({
          algorithm: "HMAC-SHA256",
          user_id: "app_scoped_1",
          issued_at: 1_788_196_800,
        }),
      ) as never,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.confirmation_code).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.url).toBe(
      `https://openreply.yoyaku.fr/api/instagram/data-deletion/${body.confirmation_code}`,
    );
    expect(mockPrisma.instagramAccount.delete).toHaveBeenCalledWith({
      where: { id: "account_1" },
    });
    expect(mockPrisma.metaDataDeletionRequest.update).toHaveBeenCalledWith({
      where: { id: "deletion_1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        completedAt: expect.any(Date),
        matchedUsername: null,
      }),
    });
  });

  it("returns a public deletion status without exposing the platform user id", async () => {
    mockPrisma.metaDataDeletionRequest.findUnique.mockResolvedValue({
      confirmationCode: "confirmation_1234567890",
      status: "COMPLETED",
      matchedUsername: "reviewer.test",
      requestedAt: new Date("2026-08-31T17:00:00Z"),
      completedAt: new Date("2026-08-31T17:00:01Z"),
    });

    const response = await getDeletionStatus(new Request("https://example.test") as never, {
      params: Promise.resolve({ code: "confirmation_1234567890" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("platformUserId");
    expect(body).toMatchObject({
      confirmation_code: "confirmation_1234567890",
      status: "COMPLETED",
    });
  });
});
