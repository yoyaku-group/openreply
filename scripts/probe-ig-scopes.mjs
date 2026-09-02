// One-shot probe: read encrypted token from prod DB, decrypt, query Meta for actual granted scopes.
// No dotenv — parse /opt/openreply/.env manually.

import { readFileSync } from "node:fs";
import pg from "pg";
import { createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// Parse .env into process.env (only if not already set).
function loadEnv(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}
loadEnv("/opt/openreply/.env");

function decryptToken(encryptedBase64) {
  const raw = process.env.ENCRYPTION_KEY;
  // Accept both hex (canonical: 64 hex chars = 32 bytes) and base64 (legacy).
  const hexMatch = /^[0-9a-fA-F]+$/.test(raw);
  const key = hexMatch ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
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
  `SELECT username, "accessToken", "tokenExpiresAt"
   FROM "InstagramAccount"
   WHERE "archivedAt" IS NULL
   ORDER BY username`
);

const GRAPH_BASE = "https://graph.instagram.com/v22.0";

for (const row of rows) {
  console.log(`\n=== @${row.username} ===`);
  console.log(`tokenExpiresAt: ${new Date(row.tokenExpiresAt).toISOString()}`);
  let token;
  try {
    token = decryptToken(row.accessToken);
  } catch (e) {
    console.log(`DECRYPT FAILED: ${e.message}`);
    continue;
  }
  console.log(`token (first 24 chars): ${token.slice(0, 24)}...`);

  const permResp = await fetch(`${GRAPH_BASE}/me/permissions?access_token=${encodeURIComponent(token)}`);
  const permBody = await permResp.json();
  console.log(`/me/permissions HTTP ${permResp.status}:`);
  console.log(JSON.stringify(permBody, null, 2));

  const meResp = await fetch(`${GRAPH_BASE}/me?fields=id,username&access_token=${encodeURIComponent(token)}`);
  const meBody = await meResp.json();
  console.log(`/me HTTP ${meResp.status}: id=${meBody.id} username=${meBody.username}`);

  const mediaResp = await fetch(`${GRAPH_BASE}/me/media?fields=id,media_type&limit=3&access_token=${encodeURIComponent(token)}`);
  const mediaBody = await mediaResp.json();
  const mediaCount = Array.isArray(mediaBody.data) ? mediaBody.data.length : 0;
  console.log(`/me/media HTTP ${mediaResp.status}: ${mediaCount} media returned`);
  if (mediaCount > 0) {
    const mediaId = mediaBody.data[0].id;
    const commentsResp = await fetch(`${GRAPH_BASE}/${mediaId}/comments?limit=3&access_token=${encodeURIComponent(token)}`);
    const commentsBody = await commentsResp.json();
    console.log(`/${mediaId}/comments HTTP ${commentsResp.status}:`);
    console.log(JSON.stringify(commentsBody, null, 2));
  }
}

await client.end();
