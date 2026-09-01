import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { META_REVIEWER_COPY } from "../lib/meta-review/copy";

describe("Meta App Review deployment contract", () => {
  it("keeps the reviewer login copy isolated from production entities", () => {
    const copy = Object.values(META_REVIEWER_COPY).join(" ");

    expect(copy).toContain("Meta App Review");
    expect(copy).not.toContain("Objects Presswerk");
    expect(copy).not.toContain("YOYAKU workspace");
  });

  it("documents every audited app-level webhook field", () => {
    const examples = [
      new URL("../.env.example", import.meta.url),
      new URL("../deploy/openreply.env.example", import.meta.url),
    ];

    for (const example of examples) {
      expect(readFileSync(example, "utf8")).toContain(
        "INSTAGRAM_APP_WEBHOOK_FIELDS=comments,messages,messaging_postbacks,messaging_seen",
      );
    }
  });
});
