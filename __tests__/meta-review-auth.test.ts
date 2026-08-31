import { describe, expect, it } from "vitest";
import {
  createMetaReviewerPasswordHash,
  readMetaReviewerConfig,
  requestHost,
  reviewerSessionExpiry,
  verifyMetaReviewerPassword,
} from "../lib/meta-review/auth";

const baseEnv = {
  META_REVIEWER_AUTH_ENABLED: "true",
  META_REVIEWER_EMAIL: "appreview@yoyaku.fr",
  META_REVIEWER_HOST: "OpenReply.Objects.Press.",
  META_REVIEWER_PASSWORD_SCRYPT: "scrypt$32768$8$1$c2FsdA$invalid",
  META_REVIEWER_WORKSPACE_ID: "ws_objects",
  META_REVIEWER_EXPIRES_AT: "2026-10-15T12:00:00.000Z",
};

describe("Meta reviewer access", () => {
  it("fails closed when disabled, expired, or incomplete", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    expect(readMetaReviewerConfig({}, now)).toBeNull();
    expect(
      readMetaReviewerConfig(
        { ...baseEnv, META_REVIEWER_AUTH_ENABLED: "false" },
        now,
      ),
    ).toBeNull();
    expect(
      readMetaReviewerConfig(
        { ...baseEnv, META_REVIEWER_EXPIRES_AT: "2026-08-31T11:59:59.000Z" },
        now,
      ),
    ).toBeNull();
  });

  it("normalizes the configured reviewer host", () => {
    const config = readMetaReviewerConfig(baseEnv, new Date("2026-08-31"));
    expect(config).toMatchObject({
      email: "appreview@yoyaku.fr",
      host: "openreply.objects.press",
      workspaceId: "ws_objects",
    });
    expect(requestHost("OpenReply.Objects.Press:443, proxy.local")).toBe(
      "openreply.objects.press",
    );
  });

  it(
    "verifies only the exact scrypt reviewer passphrase",
    () => {
      const encoded = createMetaReviewerPasswordHash(
        "review-only-passphrase",
        Buffer.alloc(24, 7),
      );
      expect(
        verifyMetaReviewerPassword("review-only-passphrase", encoded),
      ).toBe(true);
      expect(verifyMetaReviewerPassword("wrong", encoded)).toBe(false);
      expect(verifyMetaReviewerPassword("anything", "not-a-hash")).toBe(
        false,
      );
    },
    15_000,
  );

  it("caps each reviewer session at eight hours and the reviewer expiry", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    expect(
      reviewerSessionExpiry(new Date("2026-09-02T12:00:00.000Z"), now),
    ).toEqual(new Date("2026-08-31T20:00:00.000Z"));
    expect(
      reviewerSessionExpiry(new Date("2026-08-31T14:00:00.000Z"), now),
    ).toEqual(new Date("2026-08-31T14:00:00.000Z"));
  });
});
