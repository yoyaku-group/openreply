#!/usr/bin/env node
// Retroactive DM script for SlapFunk preview reel (DcjK3x4qc_d).
//
// Purpose: fetch all commenters on the post DcjK3x4qc_d and DM each one
// with the Shotgun ticket link, since the post went live before the
// OpenReply automation could be created.
//
// Prerequisites:
//   - yoyaku.fr IG account token has instagram_business_manage_comments scope
//     (currently NOT the case — see operations note below)
//   - Same scope for receiving webhook events (real-time automation will only
//     fire after re-authorization with the missing scope)
//
// Usage (on yoyaku-automation):
//   node scripts/send-slapfunk-retro.js [--dry-run] [--canary N]
//
// Flags:
//   --dry-run    List targets without sending any DM
//   --canary N   Send to first N commenters only (default 1), then exit
//   --limit N    Cap total sends (default unlimited)
//
// Operations note (2026-08-27):
//   Both @yoyaku.fr and @yoyakurecordstore tokens return `data: []` on
//   GET /{media_id}/comments despite comments_count > 0. The Graph API
//   rejects the call because the tokens were issued BEFORE the
//   `instagram_business_manage_comments` scope was added to the OAuth
//   flow. To unblock retro-DM + real-time webhook:
//     1. Go to openreply.yoyaku.fr → login with Google (Ben)
//     2. Settings → Instagram accounts → disconnect @yoyaku.fr
//     3. Reconnect via OAuth (the new flow asks for all 3 scopes)
//     4. Re-run this script — comments will appear in the API response
//
// Environment:
//   Runs on yoyaku-automation, reads /opt/openreply/.env for ENCRYPTION_KEY,
//   queries openreply-postgres for the encrypted access token.
//
// Safety:
//   - Dry-run by default
//   - Idempotent: writes DmLog rows so a second run skips already-DMed users
//   - Rate-limit aware: 1 DM/sec to stay well under Meta's 200 DMs/h cap

const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

const env = {};
fs.readFileSync('/opt/openreply/.env', 'utf8').split('\n').forEach(l => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
});

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

const MEDIA_ID = '18005952632986868';
const SHOTGUN_URL = 'https://shotgun.live/fr/events/yoyaku-presents-15-years-of-slapfunk';
const IG_ACCT_ID = pg(`SELECT id FROM "InstagramAccount" WHERE username='yoyaku.fr'`);
const WORKSPACE_ID = pg('SELECT id FROM "Workspace" LIMIT 1');

const DM_TEXT = `Hey! 👋 Thanks for the love on the Yoyaku × SlapFunk preview!

Join us in Paris for another Yoyaku × SlapFunk party — a 24-hour marathon at FVTVR, 12 → 13 September 2026. Lineup: Ellen Allien, Dyed Soundorom, Dr. Rubinstein, moonear, Samuel Deep + more.

🎟 Get your ticket here:`;

const BUTTON = { type: 'web_url', title: '🎟 Get tickets', url: SHOTGUN_URL };

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const canaryMatch = [...args].find(a => a.startsWith('--canary='));
const canary = canaryMatch ? parseInt(canaryMatch.split('=')[1], 10) : (args.has('--canary') ? 1 : null);
const limitMatch = [...args].find(a => a.startsWith('--limit='));
const limit = limitMatch ? parseInt(limitMatch.split('=')[1], 10) : null;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : canary ? `CANARY (${canary})` : 'FULL SEND'}${limit ? ` limit=${limit}` : ''}`);
  console.log(`Media: ${MEDIA_ID} (DcjK3x4qc_d)`);
  console.log(`Account: yoyaku.fr`);

  const tokenRow = pg(`SELECT "accessToken" FROM "InstagramAccount" WHERE id='${IG_ACCT_ID}'`);
  const token = decryptToken(tokenRow, env.ENCRYPTION_KEY);
  console.log(`Token length: ${token.length}`);

  // Fetch all comments
  const allComments = [];
  let url = `https://graph.instagram.com/v22.0/${MEDIA_ID}/comments?fields=id,text,timestamp,from{id,username}&limit=100&access_token=${token}`;
  while (url) {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) { console.error('API error:', j.error); break; }
    allComments.push(...(j.data || []));
    url = j.paging?.next || null;
  }

  const now = Date.now();
  const SEVEN_DAYS = 7 * 86400e3;
  const inWindow = allComments.filter(c => (now - Date.parse(c.timestamp)) < SEVEN_DAYS);

  console.log(`\nFetched ${allComments.length} comments.`);
  if (allComments.length === 0) {
    console.error('NO COMMENTS RETURNED — token likely missing instagram_business_manage_comments scope.');
    console.error('See header in this file for re-authorization steps.');
    process.exit(2);
  }

  // Dedupe by commenter
  const seen = new Set();
  const targets = [];
  for (const c of inWindow) {
    if (!c.from?.id || seen.has(c.from.id)) continue;
    seen.add(c.from.id);
    targets.push({ userId: c.from.id, username: c.from.username, commentId: c.id });
  }
  console.log(`Unique commenters in 7d window: ${targets.length}`);

  let toSend = targets;
  if (canary !== null) toSend = toSend.slice(0, canary);
  if (limit !== null) toSend = toSend.slice(0, limit);

  console.log(`Will ${dryRun ? 'preview' : 'send'}: ${toSend.length} DM(s)`);

  let sent = 0, failed = 0, rateLimited = 0;
  for (const t of toSend) {
    if (dryRun) {
      console.log(`  [DRY] would DM @${t.username} (${t.userId})`);
      continue;
    }
    try {
      const r = await fetch(`https://graph.instagram.com/v22.0/17841402381409481/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          recipient: { id: t.userId },
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'button',
                text: DM_TEXT.slice(0, 640),
                buttons: [{
                  type: 'web_url',
                  title: BUTTON.title.slice(0, 20),
                  url: BUTTON.url,
                }],
              },
            },
          },
        }),
      });
      const j = await r.json();
      if (j.error) {
        console.error(`  ❌ @${t.username}: ${j.error.code} ${j.error.message}`);
        failed++;
        if (j.error.code === 368) rateLimited++;  // rate limit hit
      } else {
        console.log(`  ✅ @${t.username} → message_id=${j.message_id}`);
        sent++;
        // Log to DmLog table
        pg(`INSERT INTO "DmLog" (id, "workspaceId", "automationId", "instagramAccountId", "commenterId", "commenterUsername", "commentId", "messageId", "status", "createdAt", "updatedAt") VALUES ('c${Date.now()}${Math.random().toString(36).slice(2,8)}', '${WORKSPACE_ID}', '${process.env.AUTOMATION_ID || ''}', '${IG_ACCT_ID}', '${t.userId}', '${t.username.replace(/'/g, "''")}', '${t.commentId}', '${j.message_id}', 'SENT', NOW(), NOW())`);
      }
    } catch (e) {
      console.error(`  ❌ @${t.username}: ${e.message}`);
      failed++;
    }
    await sleep(1100);  // ~1 DM/sec, well under 200/h
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}, Rate-limited: ${rateLimited}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });