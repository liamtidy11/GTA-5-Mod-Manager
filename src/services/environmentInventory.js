const fs = require("fs");
const path = require("path");
const { exists, isEnhancedFolder, tactixDir, ENHANCED_EXE, RPH_EXE } = require("./paths");
const registry = require("./registry");
const manifestStore = require("./manifestStore");
const protectedFiles = require("./protectedFiles");
const overlays = require("./overlays");
const versionDetector = require("./versionDetector");

// Canonical Duty environment inventory for Smart Install V2.
// Read-only. Targeted checks only — never walks the whole Duty tree.
// Versions come from versionDetector. UNKNOWN if there is no trustworthy evidence.

const SCHEMA_VERSION = 1;
const UNKNOWN = "UNKNOWN";

const CORE_COMPONENTS = [
  {
    id: "gta-enhanced",
    name: "GTA V Enhanced",
    group: "gta",
    live: [ENHANCED_EXE],
  },
  {
    id: "lspdfr",
    name: "LSPDFR",
    group: "lspdfr",
    live: [path.join("plugins", "LSPD First Response.dll"), path.join("plugins", "LSPDFR.dll")],
  },
  {
    id: "rage-plugin-hook",
    name: "RAGE Plugin Hook",
    group: "ragePluginHook",
    live: [RPH_EXE, "RAGEPluginHook.exe"],
  },
  {
    id: "directstoragefix",
    name: "DirectStorageFix",
    group: "core",
    live: ["DirectStorageFix.asi"],
  },
  {
    id: "heapadjuster",
    name: "HeapAdjuster Enhanced",
    group: "core",
    live: ["HeapAdjuster.asi", "HeapAdjusterEnhanced.asi"],
  },
  {
    id: "packfile-limit-adjuster",
    name: "Packfile Limit Adjuster Enhanced",
    group: "core",
    live: ["PackfileLimitAdjuster.asi", "PackfileLimitAdjusterEnhanced.asi"],
  },
  {
    id: "scripthookv",
    name: "Script Hook V",
    group: "core",
    live: ["ScriptHookV.dll"],
  },
  {
    id: "scripthookvdotnet",
    name: "Script Hook V .NET",
    group: "core",
    live: [
      "ScriptHookVDotNet.asi",
      "ScriptHookVDotNet2.dll",
      "ScriptHookVDotNet3.dll",
      path.join("scripts", "ScriptHookVDotNet2.dll"),
      path.join("scripts", "ScriptHookVDotNet3.dll"),
    ],
  },
];

const FRAMEWORK_FILES = [
  { id: "ragenativeui", name: "RAGENativeUI", file: "RAGENativeUI.dll" },
  { id: "lemonui", name: "LemonUI", file: "LemonUI.dll", files: ["LemonUI.dll", "LemonUI.RagePluginHook.dll"] },
  { id: "ifruitaddon2", name: "iFruitAddon2", file: "iFruitAddon2.dll" },
  {
    id: "damage-tracker-framework",
    name: "Damage Tracker Framework",
    file: "DamageTrackerFramework.dll",
    files: ["DamageTrackerFramework.dll", "DamageTrackingFramework.dll", "DamageTrackerLib.dll"],
  },
];

const PLUGIN_ROOT_SKIP = new Set([
  "lspd first response.dll",
  "lspd first response.dll.config",
  "lspd first response.pdb",
  "lspdfr.dll",
  "damagetrackerframework.dll",
  "damagetrackingframework.dll",
]);

const cache = new Map();

function normRel(rel) {
  return String(rel || "").replace(/\\/g, "/").toLowerCase();
}

function cacheKey(dutyPath, dataDir) {
  const duty = dutyPath ? path.resolve(dutyPath).toLowerCase() : "";
  const data = dataDir ? path.resolve(dataDir).toLowerCase() : "";
  return `${duty}|${data}`;
}

function filePresent(dutyPath, rel) {
  return Boolean(dutyPath) && exists(path.join(dutyPath, rel));
}

function firstPresent(dutyPath, rels) {
  for (const rel of rels || []) {
    if (filePresent(dutyPath, rel)) return rel.replace(/\\/g, "/");
  }
  return null;
}

function listNames(dir) {
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
    for (const entry of listNames(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

function componentIdForFile(rel) {
  const n = normRel(rel);
  const base = path.basename(n);
  if (base === "scripthookv.dll") return "scripthookv";
  if (
    base === "scripthookvdotnet.asi" ||
    base === "scripthookvdotnet2.dll" ||
    base === "scripthookvdotnet3.dll"
  ) {
    return "scripthookvdotnet";
  }
  if (base === "directstoragefix.asi") return "directstoragefix";
  if (base === "heapadjuster.asi" || base === "heapadjusterenhanced.asi") return "heapadjuster";
  if (base === "packfilelimitadjuster.asi" || base === "packfilelimitadjusterenhanced.asi") {
    return "packfile-limit-adjuster";
  }
  if (base === "lspd first response.dll" || base === "lspdfr.dll") return "lspdfr";
  if (base === "ragepluginhook.exe") return "rage-plugin-hook";
  if (base === "gta5_enhanced.exe") return "gta-enhanced";
  return null;
}

function collectParkedFiles(dutyPath, dataDir) {
  const parked = [];

  const tactixDisabled = path.join(tactixDir(dutyPath || ""), "disabled");
  if (exists(tactixDisabled)) {
    for (const rel of walkFiles(tactixDisabled)) {
      parked.push({ rel, source: "REGISTRY", owner: rel.split("/")[0] || "" });
    }
  }

  if (dataDir) {
    const smartDisabled = path.join(dataDir, "disabled");
    if (exists(smartDisabled)) {
      for (const rel of walkFiles(smartDisabled)) {
        parked.push({ rel, source: "MANIFEST", owner: rel.split("/")[0] || "" });
      }
    }
  }

  return parked;
}

function parkedMatchesComponent(parkedFiles, component) {
  const liveBases = new Set((component.live || []).map((rel) => path.basename(normRel(rel))));
  return parkedFiles.filter((item) => liveBases.has(path.basename(normRel(item.rel))));
}

function disabledRegistryHits(dutyPath, componentId) {
  if (!dutyPath) return [];
  return registry.load(dutyPath).mods.filter(
    (mod) =>
      mod.enabled === false &&
      (mod.files || []).some((file) => componentIdForFile(file) === componentId)
  );
}

function disabledManifestHits(dataDir, componentId) {
  if (!dataDir) return [];
  return manifestStore.list(dataDir).filter(
    (mod) =>
      mod.enabled === false &&
      (mod.files || []).some((file) => componentIdForFile(file.destination || file) === componentId)
  );
}

function describeComponent(dutyPath, component, parkedFiles, dataDir) {
  const livePath = firstPresent(dutyPath, component.live);
  const parkedHits = parkedMatchesComponent(parkedFiles, component);
  const registryHits = disabledRegistryHits(dutyPath, component.id);
  const manifestHits = disabledManifestHits(dataDir, component.id);
  const parked = parkedHits.length > 0 || registryHits.length > 0 || manifestHits.length > 0;

  let state = "MISSING";
  if (livePath) state = "INSTALLED";
  else if (parked) state = "PARKED";

  const sources = [];
  if (livePath) sources.push("FILESYSTEM");
  if (registryHits.length) sources.push("REGISTRY");
  if (manifestHits.length) sources.push("MANIFEST");
  if (parkedHits.length && !sources.includes("REGISTRY") && !sources.includes("MANIFEST")) {
    sources.push(parkedHits[0].source);
  }

  return {
    id: component.id,
    name: component.name,
    installed: Boolean(livePath || parked),
    enabled: Boolean(livePath),
    state,
    version: UNKNOWN,
    versionSource: "NONE",
    versionConfidence: "UNKNOWN",
    path: livePath,
    parkedFiles: parkedHits.map((item) => item.rel),
    parkedOrigins: parkedHits.map((item) => ({ rel: item.rel, source: item.source })),
    source: sources[0] || "FILESYSTEM",
    evidence: sources,
  };
}

function frameworkFileNames(fw) {
  return [...new Set([fw.file, ...((fw && fw.files) || [])].filter(Boolean))];
}

function scanFrameworks(dutyPath) {
  const searchDirs = dutyPath
    ? [dutyPath, path.join(dutyPath, "plugins"), path.join(dutyPath, "plugins", "LSPDFR")]
    : [];
  const found = [];
  for (const fw of FRAMEWORK_FILES) {
    let present = false;
    let filePath = null;
    for (const name of frameworkFileNames(fw)) {
      for (const dir of searchDirs) {
        const abs = path.join(dir, name);
        if (exists(abs)) {
          present = true;
          filePath = path.relative(dutyPath, abs).replace(/\\/g, "/");
          break;
        }
      }
      if (present) break;
    }
    if (!present) continue;
    found.push({
      id: fw.id,
      name: fw.name,
      file: filePath,
      installed: true,
      enabled: true,
      state: "INSTALLED",
      version: UNKNOWN,
      versionSource: "NONE",
      versionConfidence: "UNKNOWN",
      source: "FILESYSTEM",
    });
  }
  return found;
}

function scanPlugins(dutyPath) {
  const plugins = [];
  if (!dutyPath) return plugins;

  const root = path.join(dutyPath, "plugins");
  for (const entry of listNames(root)) {
    if (!entry.isFile()) continue;
    if (PLUGIN_ROOT_SKIP.has(entry.name.toLowerCase())) continue;
    plugins.push({
      name: entry.name,
      file: `plugins/${entry.name}`,
      enabled: true,
      version: UNKNOWN,
      versionSource: "NONE",
      versionConfidence: "UNKNOWN",
      source: "FILESYSTEM",
    });
  }

  const lspdfr = path.join(root, "LSPDFR");
  for (const entry of listNames(lspdfr)) {
    if (!entry.isFile()) continue;
    if (!/\.dll$/i.test(entry.name)) continue;
    plugins.push({
      name: entry.name,
      file: `plugins/LSPDFR/${entry.name}`,
      enabled: true,
      version: UNKNOWN,
      versionSource: "NONE",
      versionConfidence: "UNKNOWN",
      source: "FILESYSTEM",
    });
  }

  return plugins;
}

function scanProtected(dutyPath) {
  const listed = [];
  const config = protectedFiles.load();
  for (const entry of config.protected || []) {
    const rel = entry.matchType === "path" ? entry.match : entry.match;
    const present =
      entry.matchType === "path"
        ? filePresent(dutyPath, rel)
        : filePresent(dutyPath, rel) ||
          Boolean(dutyPath && exists(path.join(dutyPath, path.basename(rel))));
    if (!present) continue;
    listed.push({
      match: entry.match,
      owner: entry.owner || "protected",
      level: entry.level || "warning",
      present: true,
      source: "FILESYSTEM",
    });
  }
  return listed;
}

function processRunning(image) {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], {
      windowsHide: true,
      encoding: "utf8",
    });
    return new RegExp(image.replace(/\./g, "\\."), "i").test(out);
  } catch {
    return false;
  }
}

function scanOverlays(deps) {
  const status = typeof deps.overlayStatus === "function" ? deps.overlayStatus() : overlays.overlayStatus();
  const cortexRunning =
    typeof deps.cortexRunning === "function" ? Boolean(deps.cortexRunning()) : processRunning("RazerCortex.exe");

  return [
    { name: "NVIDIA Overlay", running: Boolean(status.nvidiaOverlay), source: "PROCESS" },
    { name: "NVIDIA Share", running: Boolean(status.nvidiaShare), source: "PROCESS" },
    { name: "Discord", running: Boolean(status.discord), source: "PROCESS" },
    { name: "Steam overlay", running: Boolean(status.steamOverlay), source: "PROCESS" },
    { name: "RTSS", running: Boolean(status.rtss), source: "PROCESS" },
    { name: "MSI Afterburner", running: Boolean(status.afterburner), source: "PROCESS" },
    { name: "Razer Cortex", running: Boolean(status.razerCortex) || cortexRunning, source: "PROCESS" },
  ];
}

function emptyComponent(component) {
  return {
    id: component.id,
    name: component.name,
    installed: false,
    enabled: false,
    state: "MISSING",
    version: UNKNOWN,
    versionSource: "NONE",
    versionConfidence: "UNKNOWN",
    path: null,
    parkedFiles: [],
    parkedOrigins: [],
    source: "FILESYSTEM",
    evidence: [],
  };
}

function collectManifestVersions(dutyPath, dataDir) {
  const map = new Map();
  const add = (fileRel, version) => {
    if (!version) return;
    map.set(path.basename(String(fileRel)).toLowerCase(), version);
  };
  if (dutyPath) {
    for (const mod of registry.load(dutyPath).mods) {
      for (const file of mod.files || []) add(file, mod.version);
    }
  }
  if (dataDir) {
    for (const mod of manifestStore.list(dataDir)) {
      for (const file of mod.files || []) add(file.destination || file, mod.version);
    }
  }
  return map;
}

function detectForFile(absPath, manifestVersion, reader) {
  return versionDetector.detectComponentVersion(
    { liveAbs: absPath, parkedAbs: [] },
    { readFileVersion: reader, manifestVersion }
  );
}

function applyComponentVersions(dutyPath, dataDir, components, reader, manifestVersions) {
  const specById = Object.fromEntries(CORE_COMPONENTS.map((c) => [c.id, c]));
  for (const item of components) {
    const spec = specById[item.id];
    const liveAbs = item.path && dutyPath ? path.join(dutyPath, item.path.split("/").join(path.sep)) : "";
    const parkedAbs = (item.parkedOrigins || []).map((origin) =>
      versionDetector.resolveParkedAbs(dutyPath, dataDir, origin.rel, origin.source)
    );
    const key = path.basename(item.path || (item.parkedFiles && item.parkedFiles[0]) || "").toLowerCase();
    const detected = versionDetector.detectComponentVersion(
      { liveAbs, parkedAbs },
      { readFileVersion: reader, manifestVersion: manifestVersions.get(key) }
    );
    versionDetector.applyVersion(item, detected);
    if (spec) item.live = spec.live;
  }
}

function applyListedVersions(dutyPath, items, reader, manifestVersions, relField) {
  for (const item of items) {
    const rel = item[relField];
    const abs = dutyPath && rel ? path.join(dutyPath, rel.split("/").join(path.sep)) : "";
    const detected = detectForFile(abs, manifestVersions.get(path.basename(rel || "").toLowerCase()), reader);
    versionDetector.applyVersion(item, detected);
  }
}

function copyVersion(from) {
  return {
    version: from.version || UNKNOWN,
    versionSource: from.versionSource || "NONE",
    versionConfidence: from.versionConfidence || "UNKNOWN",
  };
}

function scan({ dutyPath = "", dataDir = "", deps = {} } = {}) {
  const parkedFiles = dutyPath ? collectParkedFiles(dutyPath, dataDir) : [];
  const components = CORE_COMPONENTS.map((component) =>
    dutyPath ? describeComponent(dutyPath, component, parkedFiles, dataDir) : emptyComponent(component)
  );

  const reader = typeof deps.readFileVersion === "function" ? deps.readFileVersion : undefined;
  const manifestVersions = collectManifestVersions(dutyPath, dataDir);
  applyComponentVersions(dutyPath, dataDir, components, reader, manifestVersions);

  const frameworks = scanFrameworks(dutyPath);
  applyListedVersions(dutyPath, frameworks, reader, manifestVersions, "file");
  const plugins = scanPlugins(dutyPath);
  applyListedVersions(dutyPath, plugins, reader, manifestVersions, "file");

  const byId = Object.fromEntries(components.map((c) => [c.id, c]));
  const gta = byId["gta-enhanced"];
  const enhanced = Boolean(dutyPath && isEnhancedFolder(dutyPath));

  return {
    schemaVersion: SCHEMA_VERSION,
    dutyPath: dutyPath || "",
    scannedAt: new Date().toISOString(),
    gta: {
      edition: enhanced ? "Enhanced" : UNKNOWN,
      installed: enhanced,
      enabled: enhanced,
      state: enhanced ? "INSTALLED" : "MISSING",
      ...copyVersion(gta),
      path: gta.path,
      source: "FILESYSTEM",
    },
    lspdfr: {
      installed: byId.lspdfr.installed,
      enabled: byId.lspdfr.enabled,
      state: byId.lspdfr.state,
      ...copyVersion(byId.lspdfr),
      path: byId.lspdfr.path,
      source: byId.lspdfr.source,
    },
    ragePluginHook: {
      installed: byId["rage-plugin-hook"].installed,
      enabled: byId["rage-plugin-hook"].enabled,
      state: byId["rage-plugin-hook"].state,
      ...copyVersion(byId["rage-plugin-hook"]),
      path: byId["rage-plugin-hook"].path,
      source: byId["rage-plugin-hook"].source,
    },
    components,
    frameworks,
    plugins,
    disabledComponents: components.filter((c) => c.state === "PARKED"),
    protectedFiles: scanProtected(dutyPath),
    overlays: scanOverlays(deps),
  };
}

function getInventory({ dutyPath = "", dataDir = "", deps = {}, refresh = false } = {}) {
  const key = cacheKey(dutyPath, dataDir);
  if (!refresh && cache.has(key)) {
    const cached = cache.get(key);
    return {
      ...cached,
      overlays: scanOverlays(deps),
      cached: true,
    };
  }
  const inventory = scan({ dutyPath, dataDir, deps });
  cache.set(key, inventory);
  return { ...inventory, cached: false };
}

function refreshInventory(options = {}) {
  invalidate(options);
  return getInventory({ ...options, refresh: true });
}

function invalidate({ dutyPath, dataDir } = {}) {
  if (!dutyPath) {
    cache.clear();
    return;
  }
  cache.delete(cacheKey(dutyPath, dataDir));
  if (!dataDir) {
    const prefix = `${path.resolve(dutyPath).toLowerCase()}|`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }
}

function findComponent(inventory, id) {
  return (inventory.components || []).find((c) => c.id === id) || null;
}

module.exports = {
  SCHEMA_VERSION,
  UNKNOWN,
  CORE_COMPONENTS,
  getInventory,
  refreshInventory,
  invalidate,
  findComponent,
};
