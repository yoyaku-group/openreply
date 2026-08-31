import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  INSTAGRAM_OAUTH_SCOPE_VALUES,
  createOAuthState,
  decryptToken,
  encryptToken,
  verifyOAuthState,
} from "../lib/meta/oauth";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
});

describe("OAuth state and token encryption", () => {
  it("round-trips encrypted tokens", () => {
    const encrypted = encryptToken("long-lived-token");
    expect(encrypted).not.toBe("long-lived-token");
    expect(decryptToken(encrypted)).toBe("long-lived-token");
  });

  it("signs and verifies Instagram OAuth state", () => {
    const state = createOAuthState("workspace_123");
    expect(verifyOAuthState(state)?.workspaceId).toBe("workspace_123");
  });

  it("rejects tampered OAuth state", () => {
    const state = createOAuthState("workspace_123");
    expect(verifyOAuthState(`${state}tampered`)).toBeNull();
  });
});

describe("INSTAGRAM_OAUTH_SCOPE contents (regression — drift guard)", () => {
  // These tests prevent a future developer from silently removing a scope
  // from the OAuth request, which would recreate the 45-zombie
  // automation incident (defect sig 9a37ababec38ace5).
  it("requests instagram_business_basic", () => {
    expect(INSTAGRAM_OAUTH_SCOPE_VALUES).toContain("instagram_business_basic");
  });

  it("requests instagram_business_manage_messages", () => {
    expect(INSTAGRAM_OAUTH_SCOPE_VALUES).toContain(
      "instagram_business_manage_messages",
    );
  });

  it("requests instagram_business_manage_comments (the silent killer)", () => {
    expect(INSTAGRAM_OAUTH_SCOPE_VALUES).toContain(
      "instagram_business_manage_comments",
    );
  });

  it("requests instagram_business_manage_insights for the implemented analytics surfaces", () => {
    expect(INSTAGRAM_OAUTH_SCOPE_VALUES).toContain(
      "instagram_business_manage_insights",
    );
  });

  it("contains exactly four implemented business scopes", () => {
    expect(INSTAGRAM_OAUTH_SCOPE_VALUES).toHaveLength(4);
  });
});
