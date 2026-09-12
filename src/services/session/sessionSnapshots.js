const environmentInventory = require("../environmentInventory");
const smartInstall = require("../smartInstall");
const { readAudit } = require("../smartAudit");
const { snapshotKnown, KNOWN_IMAGES } = require("./processMonitor");
const { RECENT_LIMIT, RECENT_WINDOW_MS } = require("./sessionTypes");

const RELEVANT_EVENTS = new Set([
  "INSTALL_COMMITTED",
  "UPDATED",
  "DOWNGRADED",
  "DISABLED",
  "ENABLED",
  "REPAIRED",
  "REMOVED",
]);

const EVENT_LABELS = {
  INSTALL_COMMITTED: "installed",
  UPDATED: "updated",
  DOWNGRADED: "downgraded",
  DISABLED: "disabled",
  ENABLED: "enabled",
  REPAIRED: "repaired",
  REMOVED: "removed",
};

function compactComponent(row) {
  if (!row) return null;
  return {
    id: row.id || "",
    name: row.name || "",
    state: row.state || "",
    enabled: Boolean(row.enabled),
    version: row.version || "UNKNOWN",
  };
}

function captureEnvironment(dutyPath, dataDir, deps = {}) {
  const inventory = environmentInventory.getInventory({ dutyPath, dataDir, deps });
  return {
    gtaVersion: (inventory.gta && inventory.gta.version) || "UNKNOWN",
    lspdfrVersion: (inventory.lspdfr && inventory.lspdfr.version) || "UNKNOWN",
    rphVersion: (inventory.ragePluginHook && inventory.ragePluginHook.version) || "UNKNOWN",
    gta: compactComponent({ id: "gta-enhanced", name: "GTA V Enhanced", ...inventory.gta }),
    lspdfr: compactComponent({ id: "lspdfr", name: "LSPDFR", ...inventory.lspdfr }),
    ragePluginHook: compactComponent({
      id: "rage-plugin-hook",
      name: "Rage Plugin Hook",
      ...inventory.ragePluginHook,
    }),
    coreComponents: (inventory.components || []).map(compactComponent),
    enabledPlugins: (inventory.plugins || [])
      .filter((row) => row.enabled !== false && row.state !== "PARKED")
      .map((row) => ({ name: row.name || row.file || "", version: row.version || "UNKNOWN" })),
    parkedComponents: (inventory.disabledComponents || []).map(compactComponent),
    protectedFiles: (inventory.protectedFiles || []).map((row) => ({
      match: row.match,
      present: row.present,
      level: row.level,
    })),
    overlays: inventory.overlays || [],
  };
}

function captureMods(dataDir, dutyPath) {
  try {
    return smartInstall.list(dataDir, dutyPath).map((mod) => ({
      installId: mod.id || mod.installId || "",
      canonicalModId: mod.canonicalModId || null,
      name: mod.name || mod.displayName || "Mod",
      version: mod.version || "UNKNOWN",
      enabled: mod.enabled !== false,
      compatibility: mod.compatibilityStatus || mod.compatibility || "UNKNOWN",
      health: mod.cardHealth || mod.managedStatus || "UNKNOWN",
    }));
  } catch {
    return [];
  }
}

function captureRecentChanges(dataDir, nowMs = Date.now(), limit = RECENT_LIMIT, windowMs = RECENT_WINDOW_MS) {
  const rows = readAudit(dataDir, 200);
  const cutoff = nowMs - windowMs;
  return rows
    .filter((row) => RELEVANT_EVENTS.has(row.event) && (!row.at || Date.parse(row.at) >= cutoff))
    .slice(-limit)
    .map((row) => ({
      at: row.at,
      event: row.event,
      label: EVENT_LABELS[row.event] || row.event,
      installId: row.installId || "",
      canonicalModId: row.canonicalModId || null,
      name: row.name || "",
    }));
}

function captureProcesses(adapter) {
  return snapshotKnown(adapter || require("./processMonitor").systemAdapter(), KNOWN_IMAGES);
}

module.exports = {
  RELEVANT_EVENTS,
  captureEnvironment,
  captureMods,
  captureRecentChanges,
  captureProcesses,
};
