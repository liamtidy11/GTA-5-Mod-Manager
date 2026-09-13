const { PROVIDERS, emptyCapabilities } = require("./providerTypes");
const { createProvider } = require("./baseProvider");
const { compact } = require("../catalog");

function haystack(entry) {
  return [
    entry.name,
    entry.author,
    entry.category,
    entry.canonicalModId,
    ...(entry.tags || []),
    ...(entry.aliases || []),
    ...(entry.dllNames || []),
    entry.description,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
}

function matchesQuery(entry, query) {
  const q = String(query || "")
    .toLowerCase()
    .trim();
  if (!q) return true;
  return haystack(entry).some((part) => part.includes(q) || compact(part).includes(compact(q)));
}

function createLocalCatalogProvider(catalog) {
  const mods = (catalog && catalog.mods) || [];
  return createProvider({
    id: PROVIDERS.LOCAL_CATALOG,
    name: "Local catalog",
    capabilities: emptyCapabilities({
      SEARCH: true,
      LIST: true,
      DETAILS: true,
      OPEN_SOURCE_PAGE: true,
      DIRECT_DOWNLOAD: false,
    }),
    async list() {
      return mods.slice();
    },
    async search(query) {
      return mods.filter((row) => matchesQuery(row, query));
    },
    async details(id) {
      const needle = compact(id);
      return (
        mods.find(
          (row) => compact(row.id) === needle || compact(row.workshopId) === needle || compact(row.canonicalModId) === needle
        ) || null
      );
    },
  });
}

module.exports = { createLocalCatalogProvider, matchesQuery, haystack };
