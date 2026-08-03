import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptSavText,
  encryptSavText,
  isSavBridgeAuthorized,
  redactWebhookPayload,
  savAccountKey,
  savFingerprint,
} from "@/lib/sav/security";

const BRIDGE_TOKEN = "bridge-token-that-is-longer-than-thirty-two-characters";

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("SAV_BRIDGE_TOKEN", BRIDGE_TOKEN);
  vi.restoreAllMocks();
});

describe("SAV bridge security", () => {
  it("encrypts message content and uses a keyed stable fingerprint", () => {
    const plaintext = "Please check order 745614";
    const ciphertext = encryptSavText(plaintext);
    expect(ciphertext).not.toContain(plaintext);
    expect(decryptSavText(ciphertext)).toBe(plaintext);
    expect(savFingerprint(plaintext)).toHaveLength(64);
    expect(savFingerprint(plaintext)).toBe(savFingerprint(plaintext));
  });

  it("redacts customer text, identity, postback data, and attachments", () => {
    const payload = {
      object: "instagram",
      entry: [{
        id: "business",
        messaging: [{
          sender: { id: "customer", username: "eelco" },
          message: {
            mid: "m_1",
            text: "Order 745614",
            attachments: [{ payload: { url: "https://private.example/image" } }],
          },
        }],
      }],
    };
    const serialized = JSON.stringify(redactWebhookPayload(payload));
    expect(serialized).not.toContain("Order 745614");
    expect(serialized).not.toContain("eelco");
    expect(serialized).not.toContain("private.example");
    expect(serialized).toContain("m_1");
    expect(serialized).toContain("REDACTED");
  });

  it("authenticates only the exact bearer and never logs either token", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const valid = new Request("http://localhost", {
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}` },
    });
    expect(isSavBridgeAuthorized(valid)).toBe(true);

    const attackerToken = "attacker-token-that-is-also-longer-than-thirty-two";
    const invalid = new Request("http://localhost", {
      headers: { authorization: `Bearer ${attackerToken}` },
    });
    expect(isSavBridgeAuthorized(invalid)).toBe(false);
    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).not.toContain(BRIDGE_TOKEN);
    expect(logged).not.toContain(attackerToken);
    expect(logged).toContain("presentedFingerprint");
  });

  it("fails closed when the server secret is missing or malformed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("SAV_BRIDGE_TOKEN", "");
    expect(
      isSavBridgeAuthorized(
        new Request("http://localhost", {
          headers: { authorization: `Bearer ${BRIDGE_TOKEN}` },
        })
      )
    ).toBe(false);
  });

  it("normalizes the two supported account names into stable keys", () => {
    expect(savAccountKey("yoyaku.fr")).toBe("yoyaku_fr");
    expect(savAccountKey("yoyakurecordstore")).toBe("yoyakurecordstore");
  });
});
