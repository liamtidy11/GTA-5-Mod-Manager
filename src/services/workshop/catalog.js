const fs = require("fs");
const path = require("path");
const { CATEGORIES, ENHANCED, isAllowedSourceUrl, PROVIDERS } = require("./providers/providerTypes");

const DEFAULT_PATH = path.join(__dirname, "..", "..", "data", "workshopCatalog.json");

function compact(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeCategory(raw) {
  const cat = String(raw || "OTHER").toUpperCase();
  return CATEGORIES.includes(cat) ? cat : "OTHER";
}

function normalizeEnhanced(raw) {
  const value = String(raw || "UNKNOWN").toUpperCase();
  if (value === "LIKELY_COMPATIBLE") return "LIKELY";
  return ENHANCED.includes(value) ? value : "UNKNOWN";
}

function normalizeSource(raw, url) {
  const source = String(raw || "").toUpperCase();
  if (source === "LCPDFR" || source === "GITHUB" || source === "LOCAL" || source === "LOCAL_CATALOG") {
    return source === "LOCAL" ? "LOCAL_CATALOG" : source === "LOCAL_CATALOG" ? "LOCAL_CATALOG" : source;
  }
  try {
    const host = new URL(String(url || "")).hostname.toLowerCase();
    if (host.includes("lcpdfr.com")) return "LCPDFR";
    if (host.includes("github.com")) return "GITHUB";
  } catch {
    /* ignore */
  }
  return "LOCAL_CATALOG";
}

function archiveUnsupported(category, raw) {
  if (raw === true || String(raw || "").toUpperCase() === "UNSUPPORTED") return true;
  return category === "VEHICLE" || category === "EUP";
}

function normalizeEntry(raw, essentials = []) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const name = String(raw.name || "").trim();
  const sourceUrl = String(raw.sourceUrl || "").trim();
  if (!id || !name || !sourceUrl || !isAllowedSourceUrl(sourceUrl)) return null;
  const category = normalizeCategory(raw.category);
  const canonicalModId = String(raw.canonicalModId || id).trim();
  return {
    workshopId: `local:${id}`,
    id,
    name,
    author: String(raw.author || "").trim(),
    category,
    source: normalizeSource(raw.source, sourceUrl),
    provider: PROVIDERS.LOCAL_CATALOG,
    providerFileId: raw.providerFileId ? String(raw.providerFileId) : null,
    sourceUrl,
    canonicalModId,
    description: String(raw.description || "").trim(),
    tags: asArray(raw.tags).map(String),
    aliases: asArray(raw.aliases).map(String),
    dllNames: asArray(raw.dllNames).map(String),
    featured: raw.featured === true || essentials.includes(id),
    essential: essentials.includes(id),
    enhanced: "UNKNOWN",
    catalogEnhanced: normalizeEnhanced(raw.enhanced),
    sourceVersion: raw.sourceVersion ? String(raw.sourceVersion).trim() : "",
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : "",
    screenshots: [],
    license: raw.license ? String(raw.license) : "",
    archiveInstallUnsupported: archiveUnsupported(category, raw.archiveInstall),
    dependencies: [],
  };
}

function validateCatalog(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["Catalog is missing."], catalog: emptyCatalog() };
  if (!Array.isArray(raw.mods)) errors.push("mods must be an array.");
  const essentials = asArray(raw.essentials).map(String);
  const seen = new Set();
  const mods = [];
  for (const item of asArray(raw.mods)) {
    const entry = normalizeEntry(item, essentials);
    if (!entry) {
      errors.push(`Invalid catalog row: ${item && item.id ? item.id : "unknown"}.`);
      continue;
    }
    if (seen.has(entry.id)) {
      errors.push(`Duplicate catalog id: ${entry.id}.`);
      continue;
    }
    seen.add(entry.id);
    mods.push(entry);
  }
  return {
    ok: errors.length === 0,
    errors,
    catalog: {
      schemaVersion: Number(raw.schemaVersion) || 1,
      essentials: essentials.filter((id) => seen.has(id) || mods.some((m) => m.id === id)),
      mods,
    },
  };
}

function emptyCatalog() {
  return { schemaVersion: 1, essentials: [], mods: [] };
}

function loadCatalog(catalogPath = DEFAULT_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const checked = validateCatalog(raw);
    return { ...checked, source: "FILE", path: catalogPath };
  } catch {
    return { ok: false, errors: ["Catalog could not be read."], catalog: emptyCatalog(), source: "EMPTY", path: catalogPath };
  }
}

function findById(catalog, id) {
  const needle = compact(id);
  return (catalog.mods || []).find((row) => compact(row.id) === needle || compact(row.canonicalModId) === needle || compact(row.workshopId) === needle) || null;
}

module.exports = {
  DEFAULT_PATH,
  compact,
  normalizeEntry,
  validateCatalog,
  loadCatalog,
  findById,
  emptyCatalog,
};
