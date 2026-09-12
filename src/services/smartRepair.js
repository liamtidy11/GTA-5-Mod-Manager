const path = require("path");
const { exists, safeJoin } = require("./paths");
const { hashFileSync } = require("./hashUtil");
const { validateManifest } = require("./manifestValidate");
const { diagnoseManagedMod } = require("./orphanDetector");
const { restoreStoredFile, hasStoredFile } = require("./payloadStore");
const { isConfigFile } = require("./configPolicy");
const { SmartInstallError } = require("./smartErrors");
const { normalizeDutyDest } = require("./knowledge/gameTreeNormalize");

function repairManagedMod({ manifest, dutyPath, dataDir }) {
  const checked = validateManifest(manifest);
  if (!checked.ok) {
    throw new SmartInstallError("TRANSACTION_ERROR", checked.warning, {
      whatToDo: "The manifest is unreadable. Files were left untouched.",
    });
  }
  const before = diagnoseManagedMod(checked.manifest, { dutyPath, dataDir });
  const restored = [];
  const skipped = [];
  for (const file of checked.manifest.files || []) {
    const dest = normalizeDutyDest(file.destination) || file.destination;
    const storeKey = hasStoredFile(dataDir, checked.manifest.id, dest)
      ? dest
      : hasStoredFile(dataDir, checked.manifest.id, file.destination)
        ? file.destination
        : dest;
    let destAbs;
    try {
      destAbs = safeJoin(dutyPath, dest.replace(/\//g, path.sep));
    } catch {
      skipped.push({ destination: dest, reason: "Unsafe destination." });
      continue;
    }
    if (exists(destAbs)) {
      if (isConfigFile(dest)) {
        skipped.push({ destination: dest, reason: "Existing configuration kept." });
        continue;
      }
      continue;
    }
    if (hasStoredFile(dataDir, checked.manifest.id, storeKey) && restoreStoredFile(dataDir, checked.manifest.id, storeKey, destAbs)) {
      if (file.hash) {
        const got = hashFileSync(destAbs);
        if (got !== file.hash) {
          skipped.push({ destination: dest, reason: "Stored copy did not match the manifest hash." });
          continue;
        }
      }
      restored.push(dest);
    } else {
      skipped.push({ destination: dest, reason: "No stored copy is available to restore this file." });
    }
  }
  const after = diagnoseManagedMod(checked.manifest, { dutyPath, dataDir });
  return {
    id: checked.manifest.id,
    restored,
    skipped,
    before: before.status,
    after: after.status,
    issues: after.issues,
  };
}

module.exports = { repairManagedMod };
