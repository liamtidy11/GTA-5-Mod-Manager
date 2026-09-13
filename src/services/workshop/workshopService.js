const os = require("os");
const path = require("path");
const { loadCatalog, findById, compact } = require("./catalog");
const { createLocalCatalogProvider } = require("./providers/localCatalogProvider");
const { createLcpdfrProvider, apiStatus } = require("./providers/lcpdfrProvider");
const { isAllowedSourceUrl } = require("./providers/providerTypes");
const { toWorkshopMod } = require("./workshopModel");
const { filterMods } = require("./workshopSearch");
const { installedState } = require("./installedMatch");
const { buildHandoff, evaluateHandoff } = require("./handoff");
const library = require("./userLibrary");
const cache = require("./workshopCache");
const inbox = require("./downloadInbox");
const { scoreUpdateRisk } = require("../update/updateIntelligence");

function workshopRoot(userData) {
  return path.join(userData, "workshop");
}

function defaultDownloadDir() {
  return path.join(os.homedir(), "Downloads");
}

function mapEnhanced(knowledgeEntry) {
  const raw = knowledgeEntry && knowledgeEntry.compatibility && knowledgeEntry.compatibility.gtaEnhanced;
  const value = String(raw || "UNKNOWN").toUpperCase();
  if (value === "LIKELY_COMPATIBLE" || value === "LIKELY") return "LIKELY";
  if (value === "VERIFIED") return "VERIFIED";
  if (value === "INCOMPATIBLE") return "INCOMPATIBLE";
  if (value === "WARNING" || value === "LEGACY_ONLY") return value === "WARNING" ? "UNKNOWN" : "LEGACY_ONLY";
  return "UNKNOWN";
}

function knowledgeOf(database, canonicalModId) {
  return ((database && database.mods) || []).find((row) => row.id === canonicalModId) || null;
}

function dependencyRows(entry, { database, mods }) {
  const knowledge = knowledgeOf(database, entry.canonicalModId);
  const deps = (knowledge && knowledge.dependencies) || [];
  return deps.map((dep) => {
    const componentId = dep.modId || dep.componentId;
    const target = knowledgeOf(database, componentId);
    const installed = (mods || []).some((mod) => mod.canonicalModId === componentId) ||
      (componentId === "lspdfr" && (mods || []).some((mod) => compact(mod.name).includes("lspdfr")));
    return {
      componentId,
      name: (target && target.name) || dep.name || componentId,
      kind: dep.kind || "REQUIRED",
      installed,
      workshopId: `local:${componentId}`,
    };
  });
}

function usedByRows(entry, { database, mods }) {
  const id = entry.canonicalModId;
  const fromKnowledge = ((database && database.mods) || []).filter((row) =>
    (row.dependencies || []).some((dep) => (dep.modId || dep.componentId) === id)
  );
  return fromKnowledge.map((row) => ({
    canonicalModId: row.id,
    name: row.name,
    workshopId: `local:${row.id}`,
  }));
}

function conflictRows(entry, database) {
  const knowledge = knowledgeOf(database, entry.canonicalModId);
  return ((knowledge && knowledge.conflicts) || []).map((row) => ({
    canonicalModId: row.modId,
    name: (knowledgeOf(database, row.modId) || {}).name || row.modId,
    reason: row.reason || "",
    workshopId: `local:${row.modId}`,
  }));
}

function installOrder(entry, dependencies) {
  const missing = (dependencies || []).filter((dep) => dep.kind === "REQUIRED" && !dep.installed);
  return [...missing.map((dep, i) => ({ step: i + 1, name: dep.name, workshopId: dep.workshopId })), { step: missing.length + 1, name: entry.name, workshopId: entry.workshopId }];
}

function enrich(entry, ctx) {
  const lib = library.load(ctx.workshopRoot);
  const userEntry = ctx.userKnowledgeGet
    ? ctx.userKnowledgeGet({ installId: "", canonicalModId: entry.canonicalModId })
    : null;
  const installed = installedState(entry, {
    mods: ctx.mods,
    inventory: ctx.inventory,
    userEntry,
    sourceVersion: entry.sourceVersion,
  });
  const dependencies = dependencyRows(entry, ctx);
  const usedBy = usedByRows(entry, ctx);
  const health = ctx.healthByCanonical && ctx.healthByCanonical.get(entry.canonicalModId);
  const crash = health && health.crash ? health.crash : null;
  const collections = lib.collections.filter((col) => col.workshopIds.includes(entry.workshopId)).map((col) => col.id);
  let updateRisk = null;
  if (installed.updateAvailable) {
    updateRisk = scoreUpdateRisk({
      compatibilityUnknown: mapEnhanced(knowledgeOf(ctx.database, entry.canonicalModId)) === "UNKNOWN",
    });
  }
  return toWorkshopMod(entry, {
    author: (userEntry && userEntry.author) || entry.author,
    displayName: (userEntry && userEntry.displayName) || entry.name,
    enhancedCompatibility: mapEnhanced(knowledgeOf(ctx.database, entry.canonicalModId)),
    favorite: lib.favorites.includes(entry.workshopId),
    collections,
    dependencies,
    usedBy,
    installOrder: installOrder(entry, dependencies),
    installedState: { ...installed, updateRisk },
    health: health ? { status: health.status, reasons: health.reasons || [] } : null,
    crash,
    conflicts: conflictRows(entry, ctx.database),
    license: entry.license,
  });
}

function recommendations(mods, { profile = null } = {}) {
  const out = [];
  const seen = new Set();
  function push(reason, mod) {
    if (!mod || seen.has(mod.workshopId)) return;
    seen.add(mod.workshopId);
    out.push({ reason, workshopId: mod.workshopId, name: mod.name });
  }
  for (const mod of mods) {
    if (!mod.installedState || !mod.installedState.installed) continue;
    for (const dep of mod.dependencies || []) {
      if (dep.kind === "REQUIRED" && !dep.installed) {
        const target = mods.find((row) => row.canonicalModId === dep.componentId || row.workshopId === dep.workshopId);
        push(`Required by ${mod.name}`, target);
      }
    }
  }
  for (const mod of mods) {
    if (mod.installedState && mod.installedState.updateAvailable) push("Update available", mod);
  }
  const profileIds = new Set(((profile && profile.mods) || []).map((row) => row.canonicalModId || row.installId).filter(Boolean));
  for (const mod of mods) {
    if (profileIds.has(mod.canonicalModId)) push("In the active profile", mod);
  }
  return out.slice(0, 8);
}

function createContext(options = {}) {
  const userData = options.userData || "";
  const root = options.workshopRoot || workshopRoot(userData);
  const loaded = loadCatalog(options.catalogPath);
  cache.writeCache(root, { provider: "LOCAL_CATALOG", payload: { ids: loaded.catalog.mods.map((m) => m.id) } });
  const cached = cache.readCache(root, { ttlMs: (options.cacheRetentionHours || 24) * 3600 * 1000 });
  return {
    workshopRoot: root,
    catalog: loaded.catalog,
    catalogOk: loaded.ok,
    catalogErrors: loaded.errors,
    local: createLocalCatalogProvider(loaded.catalog),
    lcpdfr: createLcpdfrProvider({ apiKey: options.apiKey || "" }),
    cache: cached,
    mods: options.mods || [],
    inventory: options.inventory || null,
    database: options.database || { mods: [] },
    userKnowledgeGet: options.userKnowledgeGet,
    healthByCanonical: options.healthByCanonical || new Map(),
    profile: options.profile || null,
    settings: options.settings || {},
    downloadDir: options.downloadDir || defaultDownloadDir(),
    watchDownloads: options.watchDownloads === true,
    openSourceLinks: options.openSourceLinks !== false,
    providerNotice: options.providerNotice || "",
    apiKey: options.apiKey || "",
    offline: options.offline === true,
  };
}

function browse(ctx, { query = "", category = "", filter = "" } = {}) {
  const rows = ctx.catalog.mods.map((entry) => enrich(entry, ctx));
  const filtered = filterMods(rows, { query, category, filter });
  return {
    mods: filtered,
    all: rows,
    recommendations: recommendations(rows, ctx),
    essentials: rows.filter((row) => row.essential),
    featured: rows.filter((row) => row.featured),
    notice: ctx.providerNotice || (!ctx.catalogOk ? "Local catalog had validation issues. Showing valid rows only." : ""),
    cache: { lastUpdated: ctx.cache.lastUpdated, stale: ctx.cache.stale },
    offline: Boolean(ctx.offline),
    api: apiStatus({ apiKey: ctx.apiKey || "" }),
  };
}

function details(ctx, workshopId) {
  const entry = findById(ctx.catalog, workshopId) || ctx.catalog.mods.find((row) => row.workshopId === workshopId);
  if (!entry) return null;
  return enrich(entry, ctx);
}

function getMod(ctx, workshopId) {
  const entry = findById(ctx.catalog, workshopId) || ctx.catalog.mods.find((row) => row.workshopId === workshopId);
  if (!entry) return { ok: false, reason: "NOT_FOUND" };
  if (!isAllowedSourceUrl(entry.sourceUrl)) return { ok: false, reason: "BLOCKED_URL" };
  const handoff = buildHandoff(entry);
  if (ctx.watchDownloads) inbox.startWatch(ctx.workshopRoot, { workshopId: entry.workshopId, expected: handoff });
  return { ok: true, sourceUrl: entry.sourceUrl, handoff, watch: Boolean(ctx.watchDownloads), archiveInstallUnsupported: entry.archiveInstallUnsupported };
}

module.exports = {
  workshopRoot,
  defaultDownloadDir,
  mapEnhanced,
  createContext,
  browse,
  details,
  getMod,
  recommendations,
  enrich,
  evaluateHandoff,
  buildHandoff,
};
