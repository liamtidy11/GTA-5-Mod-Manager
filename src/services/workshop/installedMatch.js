const { compareVersions } = require("../versionDetector");
const { compact } = require("./catalog");

function fileBase(rel) {
  return String(rel || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase();
}

function inventoryMatch(entry, inventory) {
  if (!inventory) return null;
  if (entry.canonicalModId === "lspdfr" && inventory.lspdfr && inventory.lspdfr.state && inventory.lspdfr.state !== "MISSING") {
    return { version: inventory.lspdfr.version || "UNKNOWN", source: "inventory" };
  }
  if (
    entry.canonicalModId === "rage-plugin-hook" &&
    inventory.ragePluginHook &&
    inventory.ragePluginHook.state &&
    inventory.ragePluginHook.state !== "MISSING"
  ) {
    return { version: inventory.ragePluginHook.version || "UNKNOWN", source: "inventory" };
  }
  const wanted = new Set(
    [...(entry.dllNames || []), entry.canonicalModId, entry.id, ...(entry.aliases || [])]
      .map((name) => fileBase(String(name).endsWith(".dll") ? name : `${name}.dll`))
      .filter(Boolean)
  );
  for (const plugin of inventory.plugins || []) {
    const base = fileBase(plugin.file || plugin.name);
    if (wanted.has(base)) {
      return { version: plugin.version || "UNKNOWN", source: "inventory" };
    }
  }
  for (const fw of inventory.frameworks || []) {
    const base = fileBase(fw.file);
    if (fw.id === entry.canonicalModId || fw.id === entry.id || wanted.has(base)) {
      return { version: fw.version || "UNKNOWN", source: "inventory" };
    }
  }
  return null;
}

function findInstalled(entry, mods = []) {
  const ids = new Set([compact(entry.canonicalModId), compact(entry.id), ...((entry.aliases || []).map(compact))]);
  return (mods || []).find((mod) => {
    const keys = [mod.canonicalModId, mod.id, mod.installId, mod.name].map(compact);
    return keys.some((key) => key && ids.has(key));
  }) || null;
}

function updateAvailable(installedVersion, sourceVersion) {
  const cmp = compareVersions(installedVersion, sourceVersion);
  return cmp != null && cmp < 0;
}

function installedState(entry, { mods = [], inventory = null, userEntry = null, sourceVersion = "" } = {}) {
  const installed = findInstalled(entry, mods);
  const fromInventory = !installed ? inventoryMatch(entry, inventory) : null;
  const present = Boolean(installed) || Boolean(fromInventory);
  const installedVersion = (installed && (installed.version || "UNKNOWN")) || (fromInventory && fromInventory.version) || "";
  const available = String(sourceVersion || entry.sourceVersion || "").trim();
  const knownGood = (userEntry && userEntry.knownGoodVersion) || null;
  const update = present && available ? updateAvailable(installedVersion, available) : false;
  return {
    installed: present,
    installId: installed ? installed.id || installed.installId || null : null,
    installedVersion: present ? installedVersion || "UNKNOWN" : "",
    sourceVersion: available || "",
    updateAvailable: Boolean(update),
    knownGoodVersion: knownGood,
    match: installed ? "manifest" : fromInventory ? "inventory" : "none",
  };
}

module.exports = { findInstalled, installedState, updateAvailable, inventoryMatch };
