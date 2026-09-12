#!/usr/bin/env node
// Developer-only read-only smoke test. Not part of npm run verify.
// Opens a Duty candidate archive, lists a few entries, then proves the file hash is unchanged.

const fs = require("fs");
const path = require("path");
const archive = require("../src/services/archive/gtaArchiveService");
const { listDutyCandidateArchives } = require("../src/services/archive/archiveIndex");
const { hashOfFile } = require("../src/services/archive/rpf7OpenReader");

function dutyPath() {
  return (
    process.env.DUTY_PATH ||
    path.join(__dirname, "..", "Grand Theft Auto V Enhanced - LSPDFR")
  );
}

function officialPath() {
  return process.env.ONLINE_PATH || "";
}

function main() {
  const duty = dutyPath();
  if (!fs.existsSync(path.join(duty, "GTA5_Enhanced.exe"))) {
    console.log("SKIP  Duty path is not an Enhanced folder. Set DUTY_PATH.");
    process.exit(0);
  }
  const candidates = listDutyCandidateArchives(duty, officialPath());
  if (!candidates.length) {
    console.log("SKIP  No known candidate archives exist under Duty.");
    process.exit(0);
  }

  let opened = null;
  for (const file of candidates) {
    const before = hashOfFile(file);
    try {
      const handle = archive.openArchive(file, { mode: "readOnly", officialPath: officialPath() });
      const entries = archive.listEntries(handle).slice(0, 8);
      archive.close(handle);
      const after = hashOfFile(file);
      if (before !== after) {
        console.error(`FAIL  Archive hash changed: ${file}`);
        process.exit(1);
      }
      console.log(`OK    ${path.basename(file)} SHA-256 before/after ${before} / ${after}`);
      opened = { file, entries, hash: before };
      break;
    } catch (error) {
      const after = hashOfFile(file);
      if (before !== after) {
        console.error(`FAIL  Archive hash changed after read error: ${file}`);
        process.exit(1);
      }
      console.log(`INFO  ${path.basename(file)}: ${error.code || error.message}`);
      console.log(`INFO  ${path.basename(file)} SHA-256 before/after ${before} / ${after}`);
    }
  }

  if (!opened) {
    console.log("OK    No OPEN RPF7 candidate could be listed. Encrypted official archives are unsupported. Hashes unchanged.");
    process.exit(0);
  }

  console.log(`OK    Read-only open of ${opened.file}`);
  console.log(`OK    Sample entries: ${opened.entries.join(", ") || "(none)"}`);
  console.log("OK    Archive SHA-256 unchanged after close.");
}

main();
