#!/usr/bin/env node
// DEPRECATED 2026-08-27: thin shim for the SlapFunk preview reel campaign,
// kept so historical intervention log pointers (e.g. logs-yoyaku-io
// interventions/2026-08-27-openreply-slapfunk-reel-automation.md) still
// resolve. The canonical retroactive-DM script is scripts/send-retro.js —
// any new campaign should invoke it directly with --automation=<id>.
//
// Re-running this shim has the same effect as:
//   node scripts/send-retro.js --automation=cmtbx9kzp6nsj88rh [--canary N] [--send] [--limit N]
//
// Default is dry-run (matches send-retro.js); pass --canary or --send to
// actually send DMs. Requires Ben to have re-authorized @yoyaku.fr via
// the OpenReply dashboard so the token carries instagram_business_manage_comments.

const { spawnSync } = require("node:child_process");

const args = [
  "scripts/send-retro.js",
  "--automation=cmtbx9kzp6nsj88rh",
  ...process.argv.slice(2),
];

const result = spawnSync("node", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
