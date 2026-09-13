const { CATEGORIES, ENHANCED } = require("./providers/providerTypes");

const ENHANCED_LABELS = {
  VERIFIED: "Verified Enhanced",
  LIKELY: "Likely",
  UNKNOWN: "Unknown",
  LEGACY_ONLY: "Legacy only",
  INCOMPATIBLE: "Incompatible",
};

const CATEGORY_LABELS = {
  ESSENTIAL: "Essential",
  FRAMEWORK: "Framework",
  POLICE_INTERACTION: "Police interaction",
  BACKUP: "Backup",
  DISPATCH: "Dispatch",
  MDT: "MDT",
  CALLOUTS: "Callouts",
  TRAFFIC: "Traffic",
  IMMERSION: "Immersion",
  EMS_FIRE: "EMS / Fire",
  UTILITY: "Utility",
  GRAPHICS: "Graphics",
  VEHICLE: "Vehicles",
  EUP: "EUP",
  AUDIO: "Audio",
  OTHER: "Other",
};

const SOURCE_BADGES = {
  LCPDFR: "LCPDFR",
  GITHUB: "GitHub",
  LOCAL_CATALOG: "Local catalog",
};

function enhancedLabel(status) {
  const key = String(status || "UNKNOWN").toUpperCase();
  return ENHANCED_LABELS[key] || ENHANCED_LABELS.UNKNOWN;
}

function categoryLabel(category) {
  const key = String(category || "OTHER").toUpperCase();
  return CATEGORY_LABELS[key] || CATEGORY_LABELS.OTHER;
}

function sourceBadge(source) {
  const key = String(source || "LOCAL_CATALOG").toUpperCase();
  return SOURCE_BADGES[key] || SOURCE_BADGES.LOCAL_CATALOG;
}

function pluginLike(category) {
  return ["POLICE_INTERACTION", "BACKUP", "DISPATCH", "MDT", "CALLOUTS", "TRAFFIC", "IMMERSION", "UTILITY"].includes(
    String(category || "").toUpperCase()
  );
}

function toWorkshopMod(entry, extras = {}) {
  return {
    workshopId: entry.workshopId,
    provider: entry.provider,
    providerFileId: entry.providerFileId,
    canonicalModId: entry.canonicalModId,
    name: extras.displayName || entry.name,
    author: extras.author || entry.author || "",
    version: extras.sourceVersion || entry.sourceVersion || "",
    description: extras.description || entry.description || "",
    category: entry.category,
    categoryLabel: categoryLabel(entry.category),
    tags: entry.tags || [],
    aliases: entry.aliases || [],
    dllNames: entry.dllNames || [],
    source: entry.source,
    sourceBadge: sourceBadge(entry.source),
    sourceUrl: entry.sourceUrl,
    screenshots: extras.screenshots || entry.screenshots || [],
    license: extras.license || entry.license || "",
    licenseNote: extras.license || entry.license || "See official mod page for licence/usage terms.",
    enhancedCompatibility: extras.enhancedCompatibility || "UNKNOWN",
    enhancedLabel: enhancedLabel(extras.enhancedCompatibility || "UNKNOWN"),
    catalogEnhanced: entry.catalogEnhanced || "UNKNOWN",
    featured: Boolean(entry.featured),
    essential: Boolean(entry.essential),
    archiveInstallUnsupported: Boolean(entry.archiveInstallUnsupported),
    updatedAt: extras.updatedAt || entry.updatedAt || "",
    favorite: Boolean(extras.favorite),
    collections: extras.collections || [],
    dependencies: extras.dependencies || [],
    usedBy: extras.usedBy || [],
    installOrder: extras.installOrder || [],
    installedState: extras.installedState || {},
    health: extras.health || null,
    crash: extras.crash || null,
    conflicts: extras.conflicts || [],
  };
}

module.exports = {
  CATEGORIES,
  ENHANCED,
  ENHANCED_LABELS,
  CATEGORY_LABELS,
  SOURCE_BADGES,
  enhancedLabel,
  categoryLabel,
  sourceBadge,
  pluginLike,
  toWorkshopMod,
};
