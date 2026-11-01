import { describe, expect, it } from "vitest";
import {
  isBarcelonaAutomation,
  lintBarcelonaButtonLabel,
  lintBarcelonaCampaign,
  lintBarcelonaDoubleText,
} from "@/lib/copy/copy-linter";

const REVEAL = `Leave your email on the Barcelona list and we'll send the invitations to our in-store sessions and second-hand record markets. The store: Carrer de Llull 48. Open 7 days a week, Mon-Sat 12:00-20:00, Sun 13:00-19:00. Anything you order on yoyaku.io is picked up here for free.

Deja tu email en la lista de Barcelona y te enviaremos las invitaciones a nuestras sesiones en tienda y mercados de discos de segunda mano. La tienda: Carrer de Llull 48. Abierta 7 días a la semana, lun-sáb 12:00-20:00, dom 13:00-19:00. Todo lo que pidas en yoyaku.io se recoge aquí gratis.`;

const OPENING = `Thanks for the comment! Yoyaku Barcelona is now open 7 days a week. Want the invitations to our next in-store sessions and second-hand record markets?

¡Gracias por el comentario! Yoyaku Barcelona ya abre 7 días a la semana. ¿Quieres las invitaciones a nuestras próximas sesiones en tienda y mercados de discos de segunda mano?`;

describe("Barcelona double text", () => {
  it("accepts the English-then-Spanish body we ship", () => {
    expect(lintBarcelonaDoubleText(REVEAL)).toEqual([]);
    expect(lintBarcelonaDoubleText(OPENING)).toEqual([]);
  });

  it("rejects an English-only body", () => {
    const englishOnly = REVEAL.split("\n\n")[0];
    expect(lintBarcelonaDoubleText(englishOnly)).toEqual([
      {
        rule: "bcn-double-text",
        detail: "no Spanish version found (English only)",
      },
    ]);
  });

  it("rejects a body whose Spanish half comes first", () => {
    const [english, spanish] = REVEAL.split("\n\n");
    expect(lintBarcelonaDoubleText(`${spanish}\n\n${english}`)).toEqual([
      {
        rule: "bcn-double-text",
        detail: "Spanish comes before any English part",
      },
    ]);
  });

  it("rejects a body that is Spanish only", () => {
    const spanishOnly = REVEAL.split("\n\n")[1];
    const violations = lintBarcelonaDoubleText(spanishOnly);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("bcn-double-text");
  });

  it("accepts the shipped button labels", () => {
    expect(lintBarcelonaButtonLabel("Yes / Sí")).toEqual([]);
    expect(lintBarcelonaButtonLabel("Join / Únete")).toEqual([]);
  });

  it("rejects an English-only button label", () => {
    expect(lintBarcelonaButtonLabel("Yes, invite me")).toEqual([
      {
        rule: "bcn-double-button",
        detail: 'expected "<English> / <Spanish>", got "Yes, invite me"',
      },
    ]);
  });

  it("rejects a label whose right half is not Spanish", () => {
    expect(lintBarcelonaButtonLabel("Join / Invite")).toEqual([
      {
        rule: "bcn-double-button",
        detail: 'right half is not Spanish: "Invite"',
      },
    ]);
  });

  it("lints every field of a Barcelona campaign in one pass", () => {
    const result = lintBarcelonaCampaign({
      openingDmMessage: OPENING,
      dmMessage: REVEAL,
      openingDmButtonLabel: "Yes / Sí",
      linkButtonLabel: "Join / Únete",
    });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it("names the offending field", () => {
    const result = lintBarcelonaCampaign({
      dmMessage: REVEAL,
      linkButtonLabel: "Get the invitations",
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        rule: "bcn-double-button",
        detail:
          'linkButtonLabel: expected "<English> / <Spanish>", got "Get the invitations"',
      },
    ]);
  });
});

describe("isBarcelonaAutomation", () => {
  it("reads the marker off the keyword", () => {
    expect(isBarcelonaAutomation({ keywords: ["BCN"] })).toBe(true);
    expect(isBarcelonaAutomation({ keywords: ["bcn"] })).toBe(true);
    expect(isBarcelonaAutomation({ keywords: ["LIST", "Barcelona"] })).toBe(true);
  });

  it("reads the marker off the hashtag", () => {
    expect(isBarcelonaAutomation({ catnoTag: "yoyakubarcelona" })).toBe(true);
    expect(isBarcelonaAutomation({ catnoTag: "BCNOPEN" })).toBe(true);
  });

  it("leaves every other campaign alone", () => {
    expect(isBarcelonaAutomation({})).toBe(false);
    expect(isBarcelonaAutomation({ keywords: ["LIST"] })).toBe(false);
    expect(isBarcelonaAutomation({ catnoTag: "TO001" })).toBe(false);
    // A substring is not the marker: "BCNX" is a different keyword.
    expect(isBarcelonaAutomation({ keywords: ["BCNX"] })).toBe(false);
  });
});
