const path = require("path");
const environmentInventory = require("./environmentInventory");
const { loadCatalog, compact } = require("./workshop/catalog");

// LSPDFR plugins already in the Duty folder that Smart Install never recorded.
// Does not list Downloads, ASI, RPH, or the game itself.

const SUPPORT_DLLS = new Set([
  "calloutinterfaceapi.dll",
  "ragenativeui.dll",
  "ipt.common.dll",
  "rawcanvasui.dll",
  "commondataframework.dll",
  "lms.common.dll",
  "newtonsoft.json.dll",
  "slimdx.dll",
  "gwen.dll",
  "easyhook.dll",
  "easyhook64.dll",
  "ddsconvert.dll",
  "discordrpcnet.dll",
  "discord-rpc.dll",
  "pyrocommon.dll",
  "damagetrackerlib.dll",
]);

function destOf(file) {
  return String(typeof file === "string" ? file : (file && (file.destination || file.dest)) || "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function baseName(rel) {
  return path.posix.basename(String(rel || "").replace(/\\/g, "/")).toLowerCase();
}

function ownedDlls(smartMods = []) {
  const owned = new Set();
  for (const mod of smartMods || []) {
    for (const file of mod.files || []) {
      const dest = destOf(file);
      if (!dest.endsWith(".dll") && !dest.endsWith(".asi")) continue;
      owned.add(baseName(dest));
    }
  }
  return owned;
}

function prettyDllName(fileName) {
  return String(fileName || "")
    .replace(/\.dll$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function identify(dllName, catalog, database) {
  const lower = String(dllName || "").toLowerCase();
  const stem = compact(lower.replace(/\.dll$/i, ""));
  for (const row of (catalog && catalog.mods) || []) {
    if ((row.dllNames || []).some((name) => String(name).toLowerCase() === lower)) {
      return { name: row.name, canonicalModId: row.canonicalModId || row.id, category: row.category || "" };
    }
  }
  for (const row of (database && database.mods) || []) {
    const names = [...(((row.recognition && row.recognition.dllNames) || [])), ...((row.aliases || [])), row.name];
    if (names.some((name) => compact(String(name).replace(/\.dll$/i, "")) === stem)) {
      return { name: row.name, canonicalModId: row.id, category: row.category || "" };
    }
  }
  return { name: prettyDllName(dllName), canonicalModId: null, category: "LSPDFR_PLUGIN" };
}

function list({
  dutyPath = "",
  dataDir = "",
  smartMods = [],
  database = null,
  catalog = null,
  inventory = null,
} = {}) {
  if (!dutyPath) return [];
  const inv = inventory || environmentInventory.getInventory({ dutyPath, dataDir });
  const cat = catalog || loadCatalog().catalog;
  const owned = ownedDlls(smartMods);
  const out = [];
  for (const plugin of inv.plugins || []) {
    const rel = String(plugin.file || plugin.name || "").replace(/\\/g, "/");
    const dll = baseName(rel);
    if (!/\.dll$/i.test(dll)) continue;
    if (SUPPORT_DLLS.has(dll)) continue;
    if (owned.has(dll)) continue;
    const identity = identify(dll, cat, database);
    out.push({
      id: `disk:${rel.toLowerCase()}`,
      name: identity.name,
      canonicalModId: identity.canonicalModId,
      archiveName: identity.name,
      kinds: ["lspdfr"],
      files: [rel.replace(/\//g, "\\")],
      enabled: plugin.enabled !== false,
      discovery: "DISK",
      category: identity.category || "lspdfr_plugin",
    });
  }
  return out;
}

function merge(registryMods = [], discovered = []) {
  const covered = new Set();
  for (const mod of registryMods || []) {
    for (const file of mod.files || []) {
      const dest = destOf(file);
      if (dest) covered.add(baseName(dest));
    }
  }
  const extra = (discovered || []).filter((mod) => {
    const dest = destOf((mod.files || [])[0]);
    return dest && !covered.has(baseName(dest));
  });
  return [...(registryMods || []), ...extra];
}

module.exports = { list, merge, identify, SUPPORT_DLLS };
