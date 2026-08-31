export type MetaAppMode = "development" | "live" | "unknown";

export interface MetaAppConfiguration {
  appId: string | null;
  mode: MetaAppMode;
  webhookFields: string[];
  source: "operator_attested";
}

function list(value: string | undefined): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort();
}

export function getMetaAppConfiguration(): MetaAppConfiguration {
  const rawMode = process.env.META_APP_MODE?.trim().toLowerCase();
  return {
    appId: process.env.META_APP_ID?.trim() || null,
    mode:
      rawMode === "development" || rawMode === "live" ? rawMode : "unknown",
    webhookFields: list(process.env.INSTAGRAM_APP_WEBHOOK_FIELDS),
    // Meta does not expose a dependable Instagram Login app-level webhook
    // readback through the token rail used here. This value is therefore an
    // explicit, audited dashboard assertion; real arrivals remain stronger.
    source: "operator_attested",
  };
}
