const fs = require("fs");
const os = require("os");
const path = require("path");

const ENHANCED_EXE = "GTA5_Enhanced.exe";
const PLAY_EXE = "PlayGTAV.exe";
const RPH_EXE = "RagePluginHook.exe";

const SKIP_DIRS = new Set([
  ".tactix",
  ".git",
  "crashdumps",
  "node_modules",
]);

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function isEnhancedFolder(dir) {
  return Boolean(dir) && exists(path.join(dir, ENHANCED_EXE));
}

function isLegacyFolder(dir) {
  return Boolean(dir) && exists(path.join(dir, "GTA5.exe")) && !isEnhancedFolder(dir);
}

function sameVolume(a, b) {
  return path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase();
}

function safeJoin(root, rel) {
  const dest = path.resolve(root, rel);
  const base = path.resolve(root);
  const destNorm = dest.toLowerCase();
  const baseNorm = base.toLowerCase();
  if (destNorm !== baseNorm && !destNorm.startsWith(baseNorm + path.sep.toLowerCase()) && !destNorm.startsWith(baseNorm + "\\")) {
    throw new Error(`Blocked unsafe path: ${rel}`);
  }
  return dest;
}

async function walkFiles(dir, { skipDirs = SKIP_DIRS } = {}) {
  const files = [];
  async function visit(current) {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name.toLowerCase())) continue;
        await visit(full);
      } else if (entry.isFile()) {
        files.push(path.relative(dir, full));
      }
    }
  }
  await visit(dir);
  return files;
}

function defaultSandboxPath(officialPath) {
  const home = path.join(os.homedir(), "GTA 5 Mod Manager", "Grand Theft Auto V Enhanced - LSPDFR");
  if (sameVolume(officialPath, home)) return home;
  return path.join(path.dirname(officialPath), "Grand Theft Auto V Enhanced - Mod Manager");
}

function tactixDir(sandboxPath) {
  return path.join(sandboxPath, ".tactix");
}

module.exports = {
  ENHANCED_EXE,
  PLAY_EXE,
  RPH_EXE,
  SKIP_DIRS,
  exists,
  isEnhancedFolder,
  isLegacyFolder,
  sameVolume,
  safeJoin,
  walkFiles,
  defaultSandboxPath,
  tactixDir,
};
