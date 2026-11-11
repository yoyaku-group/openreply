// One-shot data normalization: canonicalize Automation.catnoTag rows that
// still hold a separator form (`LM-02`, `#ABC001`, `bpa 001`) so they match
// the comparison the campaign API uses since catalogue references are stored
// as `[A-Z0-9]` only.
//
// Default is DRY-RUN: it prints the count of non-canonical rows and one line
// per row (id, catnoTag, normalized, pendingNextReel, isActive,
// instagramAccountId). Nothing is written.
//
// --apply rewrites, in ONE transaction, only rows with pendingNextReel = true
// (bound and archived rows are report-only). A row whose normalized value
// would collide with another pending row of the same Instagram account is
// skipped and reported instead of silently merging two campaigns onto one
// reference.
//
// Reads DATABASE_URL. Run by hand against a target database, never from a
// cron:
//   DATABASE_URL=postgres://... node scripts/normalize-catno-tags.mjs [--apply]

import pg from "pg";

const APPLY = process.argv.includes("--apply");

function normalizeCatnoTag(value) {
  const token = value.trim().replace(/^#/, "");
  const normalized = token.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized || null;
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required (dry-run first, --apply to rewrite pending rows)");
  process.exit(1);
}

const NEEDS_NORMALIZATION =
  `"catnoTag" IS NOT NULL AND "catnoTag" <> upper(regexp_replace("catnoTag", '[^A-Za-z0-9]', '', 'g'))`;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

function printCandidates(rows, mode) {
  console.log(`COUNT ${rows.length} row(s) store a non-canonical catnoTag (${mode})`);
  for (const row of rows) {
    console.log(
      [
        row.id,
        row.catnoTag,
        normalizeCatnoTag(row.catnoTag),
        row.pendingNextReel,
        row.isActive,
        row.instagramAccountId,
      ].join(", ")
    );
  }
}

try {
  if (!APPLY) {
    const { rows: candidates } = await client.query(
      `SELECT id, "catnoTag", "pendingNextReel", "isActive", "instagramAccountId"
       FROM "Automation"
       WHERE ${NEEDS_NORMALIZATION}
       ORDER BY "createdAt", id`
    );
    printCandidates(candidates, "dry-run");
    console.log("Dry-run: nothing was written. Re-run with --apply to normalize pending rows.");
  } else {
    await client.query("BEGIN");
    try {
      // Every pending row registers its normalized reference, canonical rows
      // included: a candidate must not merge into an already-canonical
      // waiting campaign of the same account either. The candidate list is
      // read inside the same transaction, after these locks, so the reported
      // COUNT and the rewritten set come from one snapshot.
      const { rows: pendingRows } = await client.query(
        `SELECT id, "catnoTag", "instagramAccountId"
         FROM "Automation"
         WHERE "pendingNextReel" = true
         ORDER BY "createdAt", id
         FOR UPDATE`
      );
      const { rows: candidates } = await client.query(
        `SELECT id, "catnoTag", "pendingNextReel", "isActive", "instagramAccountId"
         FROM "Automation"
         WHERE ${NEEDS_NORMALIZATION}
         ORDER BY "createdAt", id`
      );
      printCandidates(candidates, "--apply");
      const takenBy = new Map();
      // Canonical pending rows claim their reference FIRST: a separator row
      // must never be rewritten onto a reference a canonical row already
      // holds, or two pending campaigns would end up waiting on the same
      // normalized reference. Only then do separator rows claim theirs, so
      // among candidates the oldest wins and the rest are skipped.
      for (const row of pendingRows) {
        const normalized = normalizeCatnoTag(row.catnoTag ?? "");
        if (!normalized || row.catnoTag !== normalized) continue;
        const key = `${row.instagramAccountId}\u0000${normalized}`;
        if (!takenBy.has(key)) takenBy.set(key, row.id);
      }
      for (const row of pendingRows) {
        const normalized = normalizeCatnoTag(row.catnoTag ?? "");
        if (!normalized || row.catnoTag === normalized) continue;
        const key = `${row.instagramAccountId}\u0000${normalized}`;
        if (!takenBy.has(key)) takenBy.set(key, row.id);
      }

      let updated = 0;
      const skipped = [];
      for (const row of candidates) {
        if (row.pendingNextReel !== true) continue;
        const normalized = normalizeCatnoTag(row.catnoTag);
        if (!normalized) {
          skipped.push({ row, reason: "the value normalizes to nothing and is left untouched" });
          continue;
        }
        const key = `${row.instagramAccountId}\u0000${normalized}`;
        const holder = takenBy.get(key);
        if (holder && holder !== row.id) {
          skipped.push({
            row,
            reason: `pending row ${holder} of the same Instagram account already holds ${normalized}`,
          });
          continue;
        }
        const result = await client.query(
          `UPDATE "Automation" SET "catnoTag" = $1 WHERE id = $2 AND "pendingNextReel" = true`,
          [normalized, row.id]
        );
        updated += result.rowCount;
      }

      await client.query("COMMIT");

      const { rows: after } = await client.query(
        `SELECT COUNT(*)::int AS count FROM "Automation" WHERE ${NEEDS_NORMALIZATION}`
      );
      console.log(
        `COUNT before: ${candidates.length}, after: ${after[0].count}; updated ${updated} pending row(s), skipped ${skipped.length}.`
      );
      for (const { row, reason } of skipped) {
        console.log(`SKIP ${row.id} (${row.catnoTag} -> ${normalizeCatnoTag(row.catnoTag)}): ${reason}`);
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}
