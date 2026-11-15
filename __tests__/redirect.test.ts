import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    trackedLink: {
      findUnique: vi.fn(),
    },
    linkClick: {
      create: vi.fn(),
    },
    dmLog: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import { NextRequest } from "next/server";

import { GET } from "../app/r/[slug]/route";

const trackedLink = {
  id: "link_123",
  workspaceId: "workspace_123",
  automationId: "automation_123",
  destinationUrl: "https://example.com/offer",
  automation: {
    instagramAccountId: "instagram_account_123",
  },
};

async function redirectTo(
  url: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return GET(
    new NextRequest(url, {
      headers: {
        "user-agent": "vitest",
        referer: "https://instagram.com/",
        "x-forwarded-for": "203.0.113.10",
        ...headers,
      },
    }) as Parameters<typeof GET>[0],
    { params: Promise.resolve({ slug: "abc123" }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.trackedLink.findUnique.mockResolvedValue(trackedLink);
  mockPrisma.linkClick.create.mockResolvedValue({});
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
});

describe("tracked link redirect route", () => {
  it("logs a workspace-isolated click and redirects to the destination", async () => {
    const response = await redirectTo("https://manychat-alternative.com/r/abc123");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/offer");
    expect(mockPrisma.trackedLink.findUnique).toHaveBeenCalledWith({
      where: { slug: "abc123" },
      select: expect.any(Object),
    });
    expect(mockPrisma.linkClick.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_123",
        automationId: "automation_123",
        instagramAccountId: "instagram_account_123",
        trackedLinkId: "link_123",
        dmLogId: null,
        userAgent: "vitest",
        referrer: "https://instagram.com/",
      }),
    });
  });

  it("redirects unknown slugs to the homepage without logging a click", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue(null);

    const response = await redirectTo("https://manychat-alternative.com/r/missing");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://manychat-alternative.com/");
    expect(mockPrisma.linkClick.create).not.toHaveBeenCalled();
  });
});

describe("tracked link redirect route — DM attribution", () => {
  beforeEach(() => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "dmlog_123",
      workspaceId: "workspace_123",
    });
  });

  it("tags the destination with the DM id when ?d= names a real DmLog", async () => {
    const response = await redirectTo(
      "https://manychat-alternative.com/r/abc123?d=dmlog_123"
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") as string);
    expect(location.origin).toBe("https://example.com");
    expect(location.pathname).toBe("/offer");
    expect(location.searchParams.get("utm_content")).toBe("dm-dmlog_123");
  });

  it("attributes the click to the DmLog", async () => {
    await redirectTo("https://manychat-alternative.com/r/abc123?d=dmlog_123");

    expect(mockPrisma.linkClick.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ dmLogId: "dmlog_123" }),
    });
  });

  it("keeps an existing utm_content instead of overwriting it", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue({
      ...trackedLink,
      destinationUrl: "https://example.com/offer?utm_content=newsletter",
    });

    const response = await redirectTo(
      "https://manychat-alternative.com/r/abc123?d=dmlog_123"
    );

    const location = new URL(response.headers.get("location") as string);
    expect(location.searchParams.getAll("utm_content")).toEqual(["newsletter"]);
  });

  it("preserves the query parameters the destination already carries", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue({
      ...trackedLink,
      destinationUrl:
        "https://example.com/offer?utm_source=instagram&utm_medium=dm&utm_campaign=catno-42&variant=black",
    });

    const response = await redirectTo(
      "https://manychat-alternative.com/r/abc123?d=dmlog_123"
    );

    const location = new URL(response.headers.get("location") as string);
    expect(location.searchParams.get("utm_source")).toBe("instagram");
    expect(location.searchParams.get("utm_medium")).toBe("dm");
    expect(location.searchParams.get("utm_campaign")).toBe("catno-42");
    expect(location.searchParams.get("variant")).toBe("black");
    expect(location.searchParams.get("utm_content")).toBe("dm-dmlog_123");
  });

  it("leaves the destination unchanged when ?d= is not a DmLog id", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue(null);

    const response = await redirectTo(
      "https://manychat-alternative.com/r/abc123?d=not-a-dmlog"
    );

    expect(response.headers.get("location")).toBe("https://example.com/offer");
    expect(mockPrisma.linkClick.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ dmLogId: null }),
    });
  });

  it("ignores a DmLog belonging to another workspace", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "dmlog_123",
      workspaceId: "someone_elses_workspace",
    });

    const response = await redirectTo(
      "https://manychat-alternative.com/r/abc123?d=dmlog_123"
    );

    expect(response.headers.get("location")).toBe("https://example.com/offer");
    expect(mockPrisma.linkClick.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ dmLogId: null }),
    });
  });

  it("leaves the destination unchanged when ?d= is missing", async () => {
    const response = await redirectTo("https://manychat-alternative.com/r/abc123");

    expect(response.headers.get("location")).toBe("https://example.com/offer");
    expect(mockPrisma.dmLog.findUnique).not.toHaveBeenCalled();
  });

});
