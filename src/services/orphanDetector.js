const path = require("path");
const { exists, safeJoin } = require("./paths");
const { safeHashFileSync } = require("./hashUtil");
const backupManager = require("./backupManager");
const { hasStoredFile } = require("./payloadStore");
const { validateManifest } = require("./manifestValidate");
const { isConfigFile } = require("./configPolicy");
const pluginSupportLayout = require("./knowledge/pluginSupportLayout");

function diagnoseManagedMod(manifest, { dutyPath, dataDir } = {}) {
  const checked = validateManifest(manifest);
  if (!checked.ok) {
    return {
      status: "BROKEN",
      issues: [{ code: "MANIFEST_ERROR", message: checked.warning }],
    };
  }
  const issues = [];
  const files = checked.manifest.files || [];
  for (const file of files) {
    const dest = file.destination;
    let destAbs = "";
    try {
      destAbs = safeJoin(dutyPath, dest.replace(/\//g, path.sep));
    } catch {
      issues.push({ code: "UNSAFE_DESTINATION", message: `Unsafe destination ${dest}` });
      continue;
    }
    const present = exists(destAbs) || pluginSupportLayout.destPresentOnDuty(dutyPath, dest);
    if (!present && checked.manifest.enabled !== false) {
      issues.push({ code: "MISSING_MANAGED_FILE", message: `Manifest lists ${dest}, but the file is missing.`, file: dest });
    }
    if (present && file.hash) {
      const current = safeHashFileSync(destAbs);
      if (current && current !== file.hash && !isConfigFile(dest)) {
        issues.push({
          code: "FILE_CHANGED_OUTSIDE",
          message: `${dest} changed outside the mod manager.`,
          file: dest,
        });
      }
    }
    if (file.backup && dataDir && !backupManager.hasBackup(dataDir, checked.manifest.id, dest)) {
      issues.push({ code: "BACKUP_MISSING", message: `Backup for ${dest} is missing.`, file: dest });
    }
    if (!present && dataDir && !hasStoredFile(dataDir, checked.manifest.id, dest) && !file.backup) {
      issues.push({
        code: "STORE_MISSING",
        message: `${dest} cannot be repaired because no stored copy exists.`,
        file: dest,
      });
    }
  }
  let status = "HEALTHY";
  if (issues.some((i) => i.code === "MANIFEST_ERROR" || i.code === "MISSING_MANAGED_FILE")) status = "BROKEN";
  else if (issues.length) status = "WARNING";
  return { status, issues };
}

function ownershipChanges(manifest, dutyPath) {
  const changes = [];
  for (const file of (manifest && manifest.files) || []) {
    const destAbs = path.join(dutyPath, String(file.destination || "").split("/").join(path.sep));
    if (!exists(destAbs) || !file.hash) continue;
    const current = safeHashFileSync(destAbs);
    if (current && current !== file.hash) {
      changes.push({ destination: file.destination, expected: file.hash, actual: current });
    }
  }
  return changes;
}

module.exports = { diagnoseManagedMod, ownershipChanges };
