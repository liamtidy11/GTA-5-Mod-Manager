// Global mod search + filters over managed mods. Pure and deterministic.

function lower(value) {
  return String(value == null ? "" : value).toLowerCase();
}

function dllNamesFor(mod, knowledgeEntry) {
  const fromFiles = (mod.files || [])
    .map((file) => String(file.destination || file).split("/").pop())
    .filter((name) => /\.dll$/i.test(name));
  const fromKnowledge = (knowledgeEntry && knowledgeEntry.recognition && knowledgeEntry.recognition.dllNames) || [];
  return [...fromFiles, ...fromKnowledge];
}

function haystackFor(mod, context = {}) {
  const byId = context.knowledgeById || new Map();
  const userById = context.userKnowledgeById || new Map();
  const entry = byId.get(mod.canonicalModId) || null;
  const userEntry = userById.get(mod.id || mod.installId) || userById.get(mod.canonicalModId) || null;
  const parts = [
    mod.name,
    userEntry && userEntry.displayName,
    entry && entry.name,
    mod.canonicalModId,
    mod.category,
    entry && entry.category,
    ...dllNamesFor(mod, entry),
    ...((entry && entry.aliases) || []),
    ...((userEntry && userEntry.aliases) || []),
    ...(((entry && entry.dependencies) || []).flatMap((d) => [d.componentId, d.modId])),
  ];
  return parts.filter(Boolean).map(lower);
}

function search(mods = [], query = "", context = {}) {
  const q = lower(query).trim();
  if (!q) return mods.slice();
  return mods.filter((mod) => haystackFor(mod, context).some((part) => part.includes(q)));
}

function healthOf(mod, context = {}) {
  const map = context.healthById || new Map();
  const row = map.get(mod.id || mod.installId);
  if (row) return row.status;
  if (mod.enabled === false) return "DISABLED";
  return String(mod.cardHealth || mod.managedStatus || "UNKNOWN").toUpperCase();
}

// filters: { statuses: [], category: "", profileId: "", updateAvailableIds: Set }
function filter(mods = [], filters = {}, context = {}) {
  let rows = mods.slice();
  const statuses = (filters.statuses || []).map((s) => String(s).toUpperCase());
  if (statuses.length) {
    rows = rows.filter((mod) => {
      const status = healthOf(mod, context);
      if (statuses.includes("ENABLED") && mod.enabled !== false) return true;
      if (statuses.includes("DISABLED") && mod.enabled === false) return true;
      return statuses.includes(status);
    });
  }
  if (filters.category) {
    const cat = lower(filters.category);
    rows = rows.filter((mod) => lower(mod.category) === cat);
  }
  if (filters.profileId) {
    const profile = (context.profiles || []).find((p) => p.profileId === filters.profileId);
    const ids = new Set(((profile && profile.mods) || []).map((m) => m.installId));
    rows = rows.filter((mod) => ids.has(mod.id || mod.installId));
  }
  if (filters.updateAvailableIds && filters.updateAvailableIds.size) {
    rows = rows.filter((mod) => filters.updateAvailableIds.has(mod.id || mod.installId));
  }
  return rows;
}

module.exports = { search, filter, dllNamesFor, haystackFor };
