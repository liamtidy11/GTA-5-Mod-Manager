#!/usr/bin/env node
// Developer-only. Does not launch GTA. Not part of npm run verify.

const { systemAdapter, snapshotKnown, KNOWN_IMAGES } = require("../src/services/session/processMonitor");

const rows = snapshotKnown(systemAdapter(), KNOWN_IMAGES).filter((row) => row.running);
if (!rows.length) {
  console.log("OK    No known GTA/RPH/overlay processes are running. Nothing launched.");
  process.exit(0);
}
console.log("OK    Observed running processes (read-only):");
for (const row of rows) console.log(`      ${row.image} pid=${row.pid}`);
console.log("OK    Session monitor adapter can see live processes without starting the game.");
