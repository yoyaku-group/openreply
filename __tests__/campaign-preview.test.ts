import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CampaignPreview from "@/components/campaign-preview";

const baseProps = {
  tab: "post" as const,
  onTabChange: vi.fn(),
  triggerType: "INBOUND_DM" as const,
  inboundKeyword: "MB059",
  username: "minibarmusic",
  avatarUrl: null,
  postThumb: null,
  caption: "",
  sampleComment: "",
  publicReplyEnabled: false,
  publicReplyMessage: "",
  openingDmEnabled: false,
  openingDmMessage: "",
  openingDmButtonLabel: "",
  revealMessage: "MB059 is available to pre-order on YOYAKU.",
  hasLink: true,
  linkButtonLabel: "Pre-order MB059",
  hasSecondLink: false,
  secondLinkButtonLabel: "",
  requireFollow: false,
  followPromptMessage: "",
  followPromptButtonLabel: "",
  followUpEnabled: false,
  followUpMessage: "",
};

describe("CampaignPreview inbound DM mode", () => {
  it("shows the inbound conversation and hides post-only tabs", () => {
    const html = renderToStaticMarkup(
      createElement(CampaignPreview, {
        ...baseProps,
      })
    );

    expect(html).toContain("Inbound DM");
    expect(html).toContain("MB059");
    expect(html).toContain("Pre-order MB059");
    expect(html).not.toContain(">Post<");
    expect(html).not.toContain(">Comments<");
  });

  it("matches worker token handling regardless of placeholder case", () => {
    const html = renderToStaticMarkup(
      createElement(CampaignPreview, {
        ...baseProps,
        inboundKeyword: "",
        revealMessage: "Hi {USERNAME}, here is {LINK}",
      })
    );

    expect(html).toContain("Your keyword");
    expect(html).toContain("Hi username, here is");
    expect(html).not.toContain("{USERNAME}");
    expect(html).not.toContain("{LINK}");
    expect(html).toContain("Pre-order MB059");
  });
});
