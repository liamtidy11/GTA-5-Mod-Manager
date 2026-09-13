const fs = require("fs");
const path = require("path");
const manifestStore = require("../manifestStore");
const profileStore = require("../profiles/profileStore");
const snapshotStore = require("../snapshots/snapshotStore");
const sessionStore = require("../session/sessionStore");
const payloadStore = require("../payloadStore");
const backupManager = require("../backupManager");

// "Check Mod Manager": validates the manager's own state. App health is kept
// separate from Duty health.

function checkWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.selfcheck-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function run(context = {}) {
  const checks = [];
  const add = (id, ok, level, detail) => checks.push({ id, ok, level: ok ? "ok" : level, detail });

  add("userdata-writable", checkWritable(context.userData || context.dataDir || ""), "bad", "Manager data folder is writable.");
  add("audit-writable", checkWritable(context.dataDir || ""), "bad", "Audit/metrics folder is writable.");

  let manifests = [];
  try {
    manifests = manifestStore.list(context.dataDir || "");
    add("manifests-readable", true, "bad", `${manifests.length} manifest(s) readable.`);
  } catch (error) {
    add("manifests-readable", false, "bad", `Manifests could not be listed: ${error.message}`);
  }
  const manifestErrors = manifests.filter((m) => m.manifestStatus === "MANIFEST_ERROR").length;
  if (manifestErrors) add("manifests-valid", false, "warn", `${manifestErrors} manifest(s) are unreadable and were skipped.`);

  try {
    const index = profileStore.loadIndex(context.profileRoot || "");
    add("profile-index", Array.isArray(index.profiles), "warn", `Profile index valid (${index.profiles.length} profile(s)).`);
  } catch (error) {
    add("profile-index", false, "warn", `Profile index invalid: ${error.message}`);
  }

  try {
    const index = snapshotStore.loadIndex(context.snapshotRoot || "");
    add("snapshot-index", Array.isArray(index.snapshots), "warn", `Snapshot index valid (${index.snapshots.length} snapshot(s)).`);
  } catch (error) {
    add("snapshot-index", false, "warn", `Snapshot index invalid: ${error.message}`);
  }

  try {
    const sessions = sessionStore.listSessions(context.sessionRoot || "");
    add("session-store", Array.isArray(sessions), "warn", `Session store valid (${sessions.length} session(s)).`);
  } catch (error) {
    add("session-store", false, "warn", `Session store invalid: ${error.message}`);
  }

  // Payload references: enabled managed files that are missing and cannot be
  // repaired (no stored copy, no backup) are broken references.
  let brokenRefs = 0;
  for (const manifest of manifests) {
    if (manifest.enabled === false) continue;
    for (const file of manifest.files || []) {
      const dest = file.destination;
      const abs = context.dutyPath ? path.join(context.dutyPath, String(dest).split("/").join(path.sep)) : "";
      const present = abs && fs.existsSync(abs);
      if (present) continue;
      const repairable =
        payloadStore.hasStoredFile(context.dataDir || "", manifest.id, dest) ||
        (context.dataDir && backupManager.hasBackup(context.dataDir, manifest.id, dest));
      if (!repairable) brokenRefs += 1;
    }
  }
  add("payload-references", brokenRefs === 0, "warn", brokenRefs === 0 ? "All managed files are present or repairable." : `${brokenRefs} managed file(s) are missing with no stored copy.`);

  if (context.dutyPath) {
    try {
      const guard = require("../launchguard").verifyLaunchIntegrity(context.dutyPath, context.officialPath);
      add("launch-invariants", guard.ok !== false, "warn", guard.ok !== false ? "Launch invariants pass." : "Launch invariants report an issue.");
    } catch (error) {
      add("launch-invariants", false, "warn", `Launch invariant check failed: ${error.message}`);
    }
  }

  const failedCritical = checks.some((c) => !c.ok && c.level === "bad");
  const failedWarn = checks.some((c) => !c.ok && c.level === "warn");
  const appHealth = failedCritical ? "BROKEN" : failedWarn ? "WARNING" : "HEALTHY";
  let dutyWarnings = [];
  if (context.dutyPath) {
    try {
      dutyWarnings = require("../knowledge/dutyWarnings").summarize({
        dutyPath: context.dutyPath,
        dataDir: context.dataDir,
      }).items;
    } catch {
      dutyWarnings = [];
    }
  }
  return { appHealth, checks, dutyWarnings };
}

module.exports = { run };
