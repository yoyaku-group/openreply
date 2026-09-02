// Verify webhook subscriptions for the 3 IG accounts.

import { readFileSync } from "node:fs";
import pg from "pg";
import { createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function loadEnv(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadEnv("/opt/openreply/.env");

function decryptToken(encryptedBase64) {
  const raw = process.env.ENCRYPTION_KEY;
  const hexMatch = /^[0-9a-fA-F]+$/.test(raw);
  const key = hexMatch ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY decode: got " + key.length + " bytes");
  const combined = Buffer.from(encryptedBase64, "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  'SELECT username, "instagramId", "accessToken", "webhookSubscribed" FROM "InstagramAccount" WHERE "archivedAt" IS NULL ORDER BY username'
);

const GRAPH_BASE = "https://graph.instagram.com/v22.0";

for (const row of rows) {
  console.log("\n=== @" + row.username + " (IG ID " + row.instagramId + ") ===");
  console.log("webhookSubscribed (DB): " + row.webhookSubscribed);
  const token = decryptToken(row.accessToken);
  const subResp = await fetch(
    GRAPH_BASE + "/" + row.instagramId + "/subscribed_apps?access_token=" + encodeURIComponent(token)
  );
  console.log("/subscribed_apps HTTP " + subResp.status);
  const subBody = await subResp.json();
  console.log(JSON.stringify(subBody, null, 2).slice(0, 1500));
}

await client.end();
