#!/usr/bin/env node
// Retroactive DM for any OpenReply comment automation.
//
// Purpose: DM every commenter on an automation's post who was NOT caught by the
// webhook or the comment reconciler — typically comments posted before the
// automation existed (or while the token lacked the comments scope). The
// automation, DM copy, button label, and tracked link are all read from the
// database; nothing campaign-specific is hardcoded here.
//
// Usage (on yoyaku-automation, from /opt/openreply):
//   node scripts/send-retro.js --automation=<id>              # dry-run (default)
//   node scripts/send-retro.js --automation=<id> --canary 1   # send to first N
//   node scripts/send-retro.js --automation=<id> --send       # full send
//   node scripts/send-retro.js --automation=<id> --send --limit 50
//
// Safety:
//   - Dry-run by default; --send or --canary is required to actually DM.
//   - Idempotent within the automation: comments already logged in DmLog for
//     this automation are skipped, and only one DM per commenter is sent, so
//     the reconciler and this script can never double-DM anyone on the same
//     campaign. A commenter DMed by a DIFFERENT automation is not skipped —
//     that matches the worker (private replies are per-comment, not per-user).
//   - Inserts use ON CONFLICT DO NOTHING on the (automationId, commentId)
//     unique constraint.
//   - Private replies via recipient {comment_id} — same mechanism as the DM
//     worker (lib/meta/client.ts), valid within 7 days of the comment.
//   - Rate-limit aware: 1 DM/sec to stay well under Meta's hourly caps.
//
// Prerequisite: the account token must carry instagram_business_manage_comments.
// If the comment fetch returns zero rows while the post shows comments, the
// token predates that scope — re-authorize the account in the dashboard first
// (Settings → Instagram → disconnect + reconnect).
//
// Environment: reads /opt/openreply/.env for ENCRYPTION_KEY and
// META_GRAPH_API_VERSION; queries the openreply-postgres container.

const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

const env = {};
fs.readFileSync('/opt/openreply/.env', 'utf8').split('\n').forEach(l => {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
});
const GRAPH_VERSION = env.META_GRAPH_API_VERSION || 'v22.0';

function decryptToken(encB64, keyHex) {
  const buf = Buffer.from(encB64, 'base64');
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(16, 32);
  const enc = buf.subarray(32);
  const key = Buffer.from(keyHex, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function pg(sql) {
  return execFileSync(
    'docker',
    ['compose', '-f', 'compose.production.yml', 'exec', '-T', 'postgres',
     'psql', '-U', 'openreply', '-d', 'openreply', '-tA', '-c', sql],
    { cwd: '/opt/openreply', encoding: 'utf8' }
  ).trim();
}

const args = process.argv.slice(2);
const automationArg = args.find(a => a.startsWith('--automation='));
if (!automationArg) {
  console.error('Usage: node scripts/send-retro.js --automation=<id> [--send | --canary N] [--limit N]');
  console.error('Default is dry-run. Find ids with: SELECT id, name FROM "Automation";');
  process.exit(1);
}
const AUTOMATION_ID = automationArg.split('=')[1];
const sendMode = args.includes('--send');
const canaryMatch = args.find(a => a.startsWith('--canary='));
const canary = canaryMatch
  ? parseInt(canaryMatch.split('=')[1], 10)
  : (args.includes('--canary') ? 1 : null);
const limitMatch = args.find(a => a.startsWith('--limit='));
const limit = limitMatch ? parseInt(limitMatch.split('=')[1], 10) : null;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cuidLike() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

async function main() {
  const mode = canary !== null ? `CANARY (${canary})` : sendMode ? 'FULL SEND' : 'DRY RUN';
  console.log(`Mode: ${mode}${limit ? ` limit=${limit}` : ''}`);

  // Load automation + account metadata (single-line fields only — dmMessage is
  // fetched on its own because it is multi-line).
  const meta = pg(`SELECT a.name, a."postId", COALESCE(a."linkButtonLabel",''), ` +
    `i."instagramId", i.username ` +
    `FROM "Automation" a JOIN "InstagramAccount" i ON i.id = a."instagramAccountId" ` +
    `WHERE a.id='${AUTOMATION_ID}'`);
  if (!meta) {
    console.error(`Automation ${AUTOMATION_ID} not found.`);
    process.exit(1);
  }
  const [name, postId, linkButtonLabel, igSid, username] = meta.split('|');
  const accessTokenEnc = pg(`SELECT i."accessToken" FROM "InstagramAccount" i ` +
    `JOIN "Automation" a ON a."instagramAccountId"=i.id WHERE a.id='${AUTOMATION_ID}'`);
  const dmMessage = pg(`SELECT "dmMessage" FROM "Automation" WHERE id='${AUTOMATION_ID}'`);
  const destinationUrl = pg(`SELECT "destinationUrl" FROM "TrackedLink" WHERE "automationId"='${AUTOMATION_ID}' ORDER BY "createdAt" DESC LIMIT 1`);

  console.log(`Automation: ${name}`);
  console.log(`Account: @${username} (${igSid})  Post: ${postId}`);
  console.log(`Link button: ${linkButtonLabel || '(none)'} → ${destinationUrl || '(no tracked link)'}`);

  const token = decryptToken(accessTokenEnc, env.ENCRYPTION_KEY);

  // Fetch all comments on the post.
  const allComments = [];
  let url = `https://graph.instagram.com/${GRAPH_VERSION}/${postId}/comments?fields=id,text,timestamp,from{id,username}&limit=100&access_token=${token}`;
  while (url) {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) { console.error('API error:', j.error); break; }
    allComments.push(...(j.data || []));
    url = j.paging?.next || null;
  }

  console.log(`\nFetched ${allComments.length} comments.`);
  if (allComments.length === 0) {
    console.error('NO COMMENTS RETURNED — token likely missing instagram_business_manage_comments scope.');
    console.error('Re-authorize the account in the dashboard (Settings → Instagram → disconnect + reconnect).');
    process.exit(2);
  }

  // Private replies are only allowed within 7 days of the comment.
  const now = Date.now();
  const SEVEN_DAYS = 7 * 86400e3;
  const inWindow = allComments.filter(c => (now - Date.parse(c.timestamp)) < SEVEN_DAYS);
  const outOfWindow = allComments.length - inWindow.length;

  // Idempotence within this automation: comments already handled, and
  // commenters already DMed by this automation (worker or a previous run).
  const handledComments = new Set(
    pg(`SELECT "commentId" FROM "DmLog" WHERE "automationId"='${AUTOMATION_ID}' AND status='SENT'`)
      .split('\n').filter(Boolean)
  );
  const dmedCommenters = new Set(
    pg(`SELECT DISTINCT "commenterId" FROM "DmLog" WHERE "automationId"='${AUTOMATION_ID}' AND status='SENT'`)
      .split('\n').filter(Boolean)
  );

  const targets = [];
  let skippedHandled = 0;
  for (const c of inWindow) {
    if (!c.from?.id) continue;
    if (handledComments.has(c.id) || dmedCommenters.has(c.from.id)) { skippedHandled++; continue; }
    if (targets.some(t => t.userId === c.from.id)) continue; // one DM per commenter, oldest comment wins
    targets.push({ userId: c.from.id, username: c.from.username, commentId: c.id, text: c.text });
  }

  console.log(`Comments in 7d window: ${inWindow.length} (skipped ${outOfWindow} outside window)`);
  console.log(`Targets after dedupe: ${targets.length} (${skippedHandled} already handled by this automation)`);

  let toSend = targets;
  if (canary !== null) toSend = toSend.slice(0, canary);
  if (limit !== null) toSend = toSend.slice(0, limit);

  const realSend = sendMode || canary !== null;
  console.log(`Will ${realSend ? 'SEND' : 'preview'}: ${toSend.length} DM(s)\n`);

  const buttons = [];
  if (destinationUrl && linkButtonLabel) {
    buttons.push({ type: 'web_url', title: linkButtonLabel.slice(0, 20), url: destinationUrl });
  }

  let sent = 0, failed = 0;
  for (const t of toSend) {
    if (!realSend) {
      console.log(`  [DRY] would DM @${t.username} (${t.userId}) — comment ${t.commentId}`);
      continue;
    }
    const message = buttons.length
      ? { attachment: { type: 'template', payload: { template_type: 'button', text: dmMessage.slice(0, 640), buttons } } }
      : { text: dmMessage.slice(0, 1000) };
    try {
      const r = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/${igSid}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          recipient: { comment_id: t.commentId },
          message,
        }),
      });
      const j = await r.json();
      if (j.error) {
        console.error(`  ❌ @${t.username}: ${j.error.code} ${j.error.message}`);
        failed++;
      } else {
        console.log(`  ✅ @${t.username} → ${j.message_id}`);
        sent++;
        const ins = `INSERT INTO "DmLog" (id, "workspaceId", "automationId", "instagramAccountId", ` +
          `"commenterId", "commenterName", "commentText", "commentId", "status", "dmSentAt", "createdAt", "updatedAt") ` +
          `SELECT '${cuidLike()}', "workspaceId", id, "instagramAccountId", ` +
          `'${t.userId}', '${(t.username || '').replace(/'/g, "''")}', '${(t.text || '').replace(/'/g, "''").slice(0, 500)}', ` +
          `'${t.commentId}', 'SENT', NOW(), NOW(), NOW() ` +
          `FROM "Automation" WHERE id='${AUTOMATION_ID}' ` +
          `ON CONFLICT ("automationId","commentId") DO NOTHING`;
        pg(ins);
      }
    } catch (e) {
      console.error(`  ❌ @${t.username}: ${e.message}`);
      failed++;
    }
    await sleep(1100); // ~1 DM/sec
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}${outOfWindow ? `, Outside 7d window: ${outOfWindow}` : ''}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
