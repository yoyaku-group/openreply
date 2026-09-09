import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { withAutomationDelivery } from "@/lib/automations/delivery-guard";
import { GET } from "@/app/api/cron/sync-calendar-intents/route";

const databaseUrl = process.env.OPENREPLY_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
// Run only against an explicitly supplied isolated database after prisma db push.
suite("Calendar dispatch PostgreSQL serialization", () => {
  let workspaceId: string, objectsWorkspaceId: string, accountId: string;
  let sql: Client;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.pathname.includes("test")) throw new Error("isolated local test database required");
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    const owner = await prisma.user.create({ data: {} });
    const workspace = await prisma.workspace.create({ data: { name: "Lifecycle fixture", ownerId: owner.id } });
    const objects = await prisma.workspace.create({ data: { name: "Objects fixture", ownerId: owner.id } });
    workspaceId = workspace.id; objectsWorkspaceId = objects.id;
    accountId = (await prisma.instagramAccount.create({ data: {
      workspaceId, instagramId: randomUUID(), username: "yoyakurecordstore", accessToken: "never-used-fixture",
    } })).id;
    sql = new Client({ connectionString: databaseUrl }); await sql.connect();
  });
  afterAll(async () => { await sql?.end(); await prisma.$disconnect(); vi.unstubAllEnvs(); });
  afterEach(() => vi.unstubAllGlobals());
  async function fixture() {
    vi.stubEnv("CALENDAR_WORKSPACE_IDS", `yoyaku=${workspaceId},objects=${objectsWorkspaceId}`);
    vi.stubEnv("CALENDAR_INTENTS_URL", "https://events.test/api/internal/publications/automation-intents");
    vi.stubEnv("CALENDAR_INTENTS_SECRET", "fixture-secret");
    return prisma.automation.create({ data: {
      workspaceId, instagramAccountId: accountId, name: "No-send fixture", keywords: ["TICKETS"], dmMessage: "fixture",
      source: "CALENDAR", sourceRevision: "revision-1", sourceDeliveryAllowed: true,
      sourceWorkspaceKey: "yoyaku", publicationKey: `calendar:${randomUUID()}`, isActive: true,
      postId: "fixture-media", calendarStatus: "published", calendarAutomationStatus: "ready",
    } });
  }
  function allow() {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ allowed: true, source_revision: "revision-1", blocking_reasons: [] })));
  }
  it("holds the row lock through delivery, then permits a pause", async () => {
    const row = await fixture(); allow();
    let entered!: () => void, finish!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const finishPromise = new Promise<void>((resolve) => { finish = resolve; });
    const send = vi.fn(async () => { entered(); await finishPromise; return "fixture-only"; });
    const delivery = withAutomationDelivery(row, send);
    await enteredPromise;
    try {
      await sql.query("SET lock_timeout = '150ms'");
      await expect(sql.query('UPDATE "Automation" SET "isActive" = false WHERE id = $1', [row.id])).rejects.toMatchObject({ code: "55P03" });
    } finally { finish(); await sql.query("SET lock_timeout = 0"); }
    expect(await delivery).toBe("fixture-only");
    await prisma.automation.update({ where: { id: row.id }, data: { isActive: false } });
    await expect(withAutomationDelivery(row, send)).rejects.toThrow("inactive");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rereads a committed pause after waiting for the row, before source fetch or send", async () => {
    const row = await fixture(); allow(); const send = vi.fn();
    await sql.query("BEGIN");
    await sql.query('UPDATE "Automation" SET "isActive" = false WHERE id = $1', [row.id]);
    const delivery = withAutomationDelivery(row, send);
    const assertion = expect(delivery).rejects.toThrow("inactive");
    await sql.query("COMMIT"); await assertion;
    expect(send).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("sync reads activation after locking and cannot undo a concurrent staff pause", async () => {
    const row = await fixture();
    const intent = { publication_key: row.publicationKey, calendar_event_id: "fixture-event",
      workspace_key: "yoyaku", account_owner: "yoyakurecordstore", publication_kind: "event", cta_keyword: "TICKETS",
      destination_url: "https://yoyaku.fr/events", external_id: "fixture-media", status: "published", automation_status: "ready",
      source_revision: "revision-1", delivery_allowed: true, blocking_reasons: [] };
    await prisma.trackedLink.create({ data: { workspaceId, automationId: row.id, slug: randomUUID(), destinationUrl: intent.destination_url } });
    vi.stubEnv("CRON_SECRET", "fixture-cron"); vi.stubEnv("CALENDAR_INTENT_SYNC_ENABLED", "true");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ intents: [intent], retirements: [], snapshot_complete: true })));
    await sql.query("BEGIN");
    await sql.query('UPDATE "Automation" SET "isActive" = false WHERE id = $1', [row.id]);
    const sync = GET(new NextRequest("http://localhost/api/cron/sync-calendar-intents", { headers: { authorization: "Bearer fixture-cron" } }));
    await sql.query("COMMIT"); expect((await sync).status).toBe(200);
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: row.id } })).isActive).toBe(false);
  });
  it("applies the additive migration and pauses only existing active Calendar rows", async () => {
    const schema = `migration_${randomUUID().replaceAll("-", "")}`;
    await sql.query("BEGIN");
    try {
      await sql.query(`CREATE SCHEMA "${schema}"`);
      await sql.query(`SET LOCAL search_path TO "${schema}"`);
      await sql.query('CREATE TABLE "Automation" (id TEXT PRIMARY KEY, source TEXT, "isActive" BOOLEAN, lifecycle TEXT)');
      await sql.query(`INSERT INTO "Automation" VALUES ('calendar','CALENDAR',true,'ACTIVE'),('manual','MANUAL',true,'ACTIVE'),('archive','CALENDAR',false,'ARCHIVED')`);
      await sql.query(readFileSync("prisma/migrations/20260909150000_calendar_delivery_lifecycle/migration.sql", "utf8"));
      const result = await sql.query('SELECT id, "isActive", lifecycle, "sourceRevision", "sourceDeliveryAllowed" FROM "Automation" ORDER BY id');
      expect(result.rows).toEqual([
        { id: "archive", isActive: false, lifecycle: "ARCHIVED", sourceRevision: null, sourceDeliveryAllowed: false },
        { id: "calendar", isActive: false, lifecycle: "PAUSED", sourceRevision: null, sourceDeliveryAllowed: false },
        { id: "manual", isActive: true, lifecycle: "ACTIVE", sourceRevision: null, sourceDeliveryAllowed: false },
      ]);
    } finally { await sql.query("ROLLBACK"); }
  });
});
