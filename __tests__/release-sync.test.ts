import { describe, expect, it } from "vitest";
import {
  captionMatchesCatno,
  deriveInstoreEvents,
  deriveReleaseEvents,
  instoreDedupKey,
  type ShopProduct,
} from "@/lib/release-sync/shop-feed";
import { selectMediaForPendingAutomation } from "@/lib/release-sync/media-binding";
import type { InstagramMedia } from "@/lib/meta/client";

function product(overrides: Partial<ShopProduct>): ShopProduct {
  return {
    sku: "TO001",
    artist: "Theo Kottis",
    label: "Yoyaku",
    title: "Pressure EP",
    url: "https://yoyaku.io/release/theo-kottis-pressure-ep-to001/",
    stock_status: "onbackorder",
    is_preorder: true,
    published_gmt: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

describe("release event derivation", () => {
  it("derives preorder_open for an unseen preorder", () => {
    const events = deriveReleaseEvents([product({})], new Map());
    expect(events).toHaveLength(1);
    expect(events[0].facts.eventType).toBe("preorder_open");
    expect(events[0].sku).toBe("TO001");
  });

  it("derives release_live on the preorder-to-stock flip", () => {
    const events = deriveReleaseEvents(
      [product({ stock_status: "instock" })],
      new Map([["TO001", "onbackorder"]])
    );
    expect(events[0].facts.eventType).toBe("release_live");
  });

  it("derives restock on the out-of-stock-to-stock flip", () => {
    const events = deriveReleaseEvents(
      [product({ stock_status: "instock" })],
      new Map([["TO001", "outofstock"]])
    );
    expect(events[0].facts.eventType).toBe("restock");
  });

  it("derives release_live for an unseen product already in stock", () => {
    const events = deriveReleaseEvents(
      [product({ stock_status: "instock" })],
      new Map()
    );
    expect(events[0].facts.eventType).toBe("release_live");
  });

  it("derives nothing for unchanged status or stock-out transitions", () => {
    expect(
      deriveReleaseEvents([product({})], new Map([["TO001", "onbackorder"]]))
    ).toEqual([]);
    expect(
      deriveReleaseEvents(
        [product({ stock_status: "outofstock" })],
        new Map([["TO001", "instock"]])
      )
    ).toEqual([]);
  });
});

describe("instore event derivation", () => {
  it("keys events on the artist and falls back to the shop SoundCloud", () => {
    const events = deriveInstoreEvents([
      {
        artist: "Didier Allyne",
        youtube_url: "https://youtu.be/x",
        soundcloud_url: "",
        published_gmt: "2026-08-01T10:00:00Z",
      },
    ]);
    expect(events[0].sku).toBe(instoreDedupKey("Didier Allyne"));
    expect(events[0].facts).toMatchObject({
      eventType: "instore_published",
      soundcloudUrl: "https://soundcloud.com/yoyaku",
    });
  });
});

describe("caption catno matching", () => {
  it("matches the hashtag case-insensitively anywhere in the caption", () => {
    expect(captionMatchesCatno("Out friday. #to001 preorder in bio", "TO001")).toBe(
      true
    );
    expect(
      captionMatchesCatno("New one from Theo Kottis #TO001", "TO001")
    ).toBe(true);
  });

  it("does not match a longer catno sharing the prefix", () => {
    expect(captionMatchesCatno("#TO0011 out now", "TO001")).toBe(false);
    expect(captionMatchesCatno("#GETTRAUM017", "GETTRAUM01")).toBe(false);
  });

  it("requires the hashtag form and a caption", () => {
    expect(captionMatchesCatno("TO001 without hash", "TO001")).toBe(false);
    expect(captionMatchesCatno(undefined, "TO001")).toBe(false);
  });
});

describe("pending media binding", () => {
  const createdAt = new Date("2026-08-01T10:00:00Z");
  const reel = (
    id: string,
    timestamp: string,
    caption?: string
  ): InstagramMedia => ({
    id,
    timestamp,
    caption,
    media_type: "VIDEO",
    media_product_type: "REELS",
  });

  it("fails closed when a SKU-tagged automation has no exact hashtag match", () => {
    const media = [
      reel("unrelated", "2026-08-02T10:00:00Z", "New reel #OTHER001"),
    ];

    expect(
      selectMediaForPendingAutomation(media, createdAt, "TO001")
    ).toBeUndefined();
  });

  it("binds a SKU-tagged automation only to its earliest exact match", () => {
    const media = [
      reel("later", "2026-08-03T10:00:00Z", "#TO001 out now"),
      reel("earlier", "2026-08-02T10:00:00Z", "Preorder #to001"),
    ];

    expect(
      selectMediaForPendingAutomation(media, createdAt, "TO001")?.id
    ).toBe("earlier");
  });

  it("retains explicit next-reel behavior only without a SKU", () => {
    const media = [
      reel("next", "2026-08-02T10:00:00Z", "Instore announcement"),
      reel("later", "2026-08-03T10:00:00Z", "Another reel"),
    ];

    expect(selectMediaForPendingAutomation(media, createdAt, null)?.id).toBe(
      "next"
    );
  });
});
