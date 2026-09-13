const { compact } = require("./catalog");
const { pluginLike } = require("./workshopModel");

function haystack(mod) {
  return [
    mod.name,
    mod.author,
    mod.category,
    mod.canonicalModId,
    ...(mod.tags || []),
    ...(mod.aliases || []),
    ...(mod.dllNames || []),
    ...((mod.dependencies || []).map((d) => d.name || d.componentId)),
    mod.description,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
}

function search(mods = [], query = "") {
  const q = String(query || "")
    .toLowerCase()
    .trim();
  if (!q) return mods.slice();
  const needle = compact(q);
  return mods.filter((mod) => haystack(mod).some((part) => part.includes(q) || compact(part).includes(needle)));
}

function matchesFilter(mod, filter = "") {
  const key = String(filter || "").toUpperCase();
  if (!key || key === "ALL" || key === "FEATURED") return key === "FEATURED" ? Boolean(mod.featured) : true;
  if (key === "ESSENTIAL") return Boolean(mod.essential);
  if (key === "FAVORITES") return Boolean(mod.favorite);
  if (key === "INSTALLED") return Boolean(mod.installedState && mod.installedState.installed);
  if (key === "NOT_INSTALLED") return !(mod.installedState && mod.installedState.installed);
  if (key === "UPDATES") return Boolean(mod.installedState && mod.installedState.updateAvailable);
  if (key === "ENHANCED") return ["VERIFIED", "LIKELY"].includes(String(mod.enhancedCompatibility || "").toUpperCase());
  if (key === "KNOWN_COMPATIBLE") return ["VERIFIED", "LIKELY"].includes(String(mod.enhancedCompatibility || "").toUpperCase());
  if (key === "UNKNOWN_COMPATIBILITY") return String(mod.enhancedCompatibility || "UNKNOWN").toUpperCase() === "UNKNOWN";
  if (key === "FRAMEWORKS" || key === "FRAMEWORK") return String(mod.category).toUpperCase() === "FRAMEWORK";
  if (key === "CALLOUTS") return String(mod.category).toUpperCase() === "CALLOUTS";
  if (key === "PLUGINS") return pluginLike(mod.category);
  if (key === "VEHICLES" || key === "VEHICLE") return String(mod.category).toUpperCase() === "VEHICLE";
  if (key === "EUP") return String(mod.category).toUpperCase() === "EUP";
  if (key.startsWith("COLLECTION:")) {
    const id = key.slice("COLLECTION:".length);
    return (mod.collections || []).includes(id);
  }
  return String(mod.category || "").toUpperCase() === key;
}

function filterMods(mods = [], { query = "", category = "", filter = "" } = {}) {
  let rows = search(mods, query);
  if (category) rows = rows.filter((mod) => String(mod.category).toUpperCase() === String(category).toUpperCase());
  if (filter) rows = rows.filter((mod) => matchesFilter(mod, filter));
  return rows;
}

module.exports = { search, filterMods, matchesFilter, haystack };
