const fs = require("fs");
const path = require("path");
const payloadStore = require("./payloadStore");
const manifestStore = require("./manifestStore");
const { safeHashFileSync } = require("./hashUtil");
const { isConfigFile, lineDiff } = require("./configPolicy");

// Read intelligence for managed config files, plus a safe single-file restore
// of the installed default. Reuses the existing payload store and diff code.

function dutyAbs(dutyPath, destination) {
  return path.join(dutyPath, String(destination).split("/").join(path.sep));
}

function storedDefaultAbs(dataDir, installId, destination) {
  return path.join(payloadStore.storeRoot(dataDir, installId), String(destination).replace(/\\/g, "/").split("/").join(path.sep));
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

// Lists managed config files for a mod with drift metadata.
function describeManagedConfigs(mod, context = {}) {
  const { dutyPath = "", dataDir = "", knownGoodHash = null } = context;
  const manifest = mod.files ? mod : manifestStore.read(dataDir, mod.id || mod.installId) || mod;
  const out = [];
  for (const file of manifest.files || []) {
    const dest = file.destination || file;
    if (!isConfigFile(dest)) continue;
    const abs = dutyAbs(dutyPath, dest);
    const present = fs.existsSync(abs);
    const currentHash = present ? safeHashFileSync(abs) : null;
    const defaultHash = file.hash || null;
    let lastChanged = null;
    try {
      lastChanged = present ? fs.statSync(abs).mtime.toISOString() : null;
    } catch {
      lastChanged = null;
    }
    const hasDefault = payloadStore.hasStoredFile(dataDir, manifest.id, dest);
    out.push({
      destination: dest,
      present,
      currentHash,
      defaultHash,
      knownGoodHash: knownGoodHash || null,
      modifiedFromDefault: Boolean(currentHash && defaultHash && currentHash !== defaultHash),
      externallyModified: Boolean(currentHash && defaultHash && currentHash !== defaultHash),
      matchesKnownGood: Boolean(knownGoodHash && currentHash && currentHash === knownGoodHash),
      lastChanged,
      canRestoreDefault: hasDefault,
    });
  }
  return out;
}

function diffAgainstDefault(mod, destination, context = {}) {
  const { dutyPath = "", dataDir = "" } = context;
  const installId = mod.id || mod.installId;
  const current = readText(dutyAbs(dutyPath, destination));
  const original = readText(storedDefaultAbs(dataDir, installId, destination));
  return { destination, diff: lineDiff(original, current), hasDefault: Boolean(original) };
}

// Safe single-file restore of the installed default. Backs up the current file
// next to it so the action is reversible.
function restoreDefault(context, installId, destination) {
  const { dutyPath = "", dataDir = "" } = context;
  const src = storedDefaultAbs(dataDir, installId, destination);
  if (!fs.existsSync(src)) {
    const error = new Error(`No stored default is available for ${destination}.`);
    error.code = "NO_DEFAULT";
    throw error;
  }
  const abs = dutyAbs(dutyPath, destination);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) {
    fs.copyFileSync(abs, `${abs}.bak-${Date.now()}`);
  }
  fs.copyFileSync(src, abs);
  return { restored: true, destination };
}

module.exports = { describeManagedConfigs, diffAgainstDefault, restoreDefault, storedDefaultAbs };
