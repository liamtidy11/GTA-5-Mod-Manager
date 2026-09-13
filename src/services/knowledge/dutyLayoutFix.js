const fs = require("fs");
const path = require("path");
const { exists, safeJoin, isEnhancedFolder } = require("../paths");
const { isGameTreeDirName, normalizeDutyDest, destNeedsNormalize, normSlash } = require("./gameTreeNormalize");
const manifestStore = require("../manifestStore");
const { storeRoot, hasStoredFile, restoreStoredFile, saveInstalledFile } = require("../payloadStore");

const NEVER_OVERWRITE = new Set([
  "xinput1_4.dll",
  "dinput8.dll",
  "startup.rphs",
  "ragepluginhook.exe",
  "ragepluginhook.ini",
  "gta5_enhanced.exe",
  "gta5_enhanced_be.exe",
  "playgtav.exe",
  "newtonsoft.json.dll",
  "lspd first response.dll",
]);

const pluginSupportLayout = require("./pluginSupportLayout");

const DATA_PATH = path.join(__dirname, "..", "..", "data", "pluginDataFiles.json");

function loadPluginData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    return { plugins: [] };
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function canWrite(destRel, destAbs) {
  const base = path.basename(destRel).toLowerCase();
  if (NEVER_OVERWRITE.has(base) && exists(destAbs)) return false;
  return true;
}

function copyMissing(srcAbs, destAbs) {
  if (!exists(srcAbs)) return false;
  if (exists(destAbs)) return false;
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
  return true;
}

function relocateWrapperTrees(dutyPath) {
  const moved = [];
  const skipped = [];
  for (const entry of listDir(dutyPath)) {
    if (!entry.isDirectory() || !isGameTreeDirName(entry.name)) continue;
    const wrapper = path.join(dutyPath, entry.name);
    for (const abs of walkFiles(wrapper)) {
      const rel = normSlash(path.relative(wrapper, abs));
      if (!rel || rel === "." || rel.includes("..")) continue;
      let destAbs;
      try {
        destAbs = safeJoin(dutyPath, rel.split("/").join(path.sep));
      } catch {
        skipped.push(rel);
        continue;
      }
      if (!canWrite(rel, destAbs)) {
        skipped.push(rel);
        continue;
      }
      if (copyMissing(abs, destAbs)) moved.push(rel);
    }
  }
  return { moved, skipped };
}

function findStoreRel(dataDir, installId, destRel) {
  const wanted = normalizeDutyDest(destRel);
  if (hasStoredFile(dataDir, installId, destRel)) return destRel;
  if (wanted && hasStoredFile(dataDir, installId, wanted)) return wanted;
  const root = storeRoot(dataDir, installId);
  if (!exists(root)) return "";
  const needle = wanted.toLowerCase();
  for (const abs of walkFiles(root)) {
    const rel = normSlash(path.relative(root, abs));
    if (normalizeDutyDest(rel).toLowerCase() === needle) return rel;
  }
  return "";
}

function repairManifestDests({ dutyPath, dataDir }) {
  const repaired = [];
  if (!dataDir) return repaired;
  for (const manifest of manifestStore.list(dataDir)) {
    let changed = false;
    const files = (manifest.files || []).map((file) => {
      const raw = file.destination || "";
      const dest = normalizeDutyDest(raw);
      if (!dest || dest === normSlash(raw)) return file;
      const storeRel = findStoreRel(dataDir, manifest.id, raw) || findStoreRel(dataDir, manifest.id, dest);
      let destAbs;
      try {
        destAbs = safeJoin(dutyPath, dest.split("/").join(path.sep));
      } catch {
        return file;
      }
      if (storeRel && canWrite(dest, destAbs) && !exists(destAbs)) {
        const src = path.join(storeRoot(dataDir, manifest.id), storeRel.split("/").join(path.sep));
        if (copyMissing(src, destAbs)) {
          repaired.push(dest);
          try {
            saveInstalledFile(dataDir, manifest.id, dest, destAbs);
          } catch {
            /* store rewrite is optional */
          }
        }
      }
      changed = true;
      return { ...file, destination: dest };
    });
    if (changed) {
      manifestStore.write(dataDir, { ...manifest, files });
    }
  }
  return repaired;
}

function restoreRequiredPluginData({ dutyPath, dataDir }) {
  const restored = [];
  if (!dutyPath) return restored;
  for (const plugin of loadPluginData().plugins || []) {
    const dllAbs = path.join(dutyPath, String(plugin.dll || "").split("/").join(path.sep));
    if (!exists(dllAbs)) continue;
    for (const required of plugin.required || []) {
      const dest = normalizeDutyDest(required);
      const destAbs = path.join(dutyPath, dest.split("/").join(path.sep));
      if (exists(destAbs)) continue;
      for (const manifest of dataDir ? manifestStore.list(dataDir) : []) {
        const storeRel = findStoreRel(dataDir, manifest.id, dest);
        if (!storeRel) continue;
        if (restoreStoredFile(dataDir, manifest.id, storeRel, destAbs)) {
          restored.push(dest);
          break;
        }
      }
    }
  }
  return restored;
}

function healDutyLayout({ dutyPath = "", dataDir = "" } = {}) {
  if (!dutyPath || !isEnhancedFolder(dutyPath)) {
    return { ok: false, moved: [], repaired: [], restored: [], skipped: [] };
  }
  const relocated = relocateWrapperTrees(dutyPath);
  const repaired = repairManifestDests({ dutyPath, dataDir });
  const restored = restoreRequiredPluginData({ dutyPath, dataDir });
  const cleared = pluginSupportLayout.clearStraySupportDlls(dutyPath);
  const mirrored = pluginSupportLayout.mirrorPluginLibraries(dutyPath);
  return {
    ok: true,
    moved: relocated.moved,
    skipped: relocated.skipped,
    repaired,
    restored,
    removedSupport: cleared.removed,
    mirroredLibraries: mirrored.copied,
    removedLibraries: mirrored.removed || [],
    changed: Boolean(relocated.moved.length || repaired.length || restored.length || cleared.changed || mirrored.changed),
  };
}

module.exports = {
  healDutyLayout,
  relocateWrapperTrees,
  repairManifestDests,
  restoreRequiredPluginData,
};
