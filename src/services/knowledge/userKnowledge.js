const fs = require("fs");
const path = require("path");

// User-owned knowledge overrides. Kept OUTSIDE application source (dataDir).
// Built-in knowledge (src/data/modKnowledge.json) is never modified here.
//
// Deterministic priority for any resolved field:
//   USER_OVERRIDE > LOCAL_VERIFIED_DATA > BUILT_IN > README_EVIDENCE > UNKNOWN
// A user override is always marked as user-provided, not verified global truth.

const SCHEMA_VERSION = 1;

const PRIORITY = ["USER_OVERRIDE", "LOCAL_VERIFIED_DATA", "BUILT_IN", "README_EVIDENCE", "UNKNOWN"];

const SOURCE_BY_TIER = {
  USER_OVERRIDE: "user",
  LOCAL_VERIFIED_DATA: "localVerified",
  BUILT_IN: "builtIn",
  README_EVIDENCE: "readme",
};

// Editable fields. Anything not listed here is ignored on write.
const STRING_FIELDS = [
  "displayName",
  "author",
  "category",
  "versionOverride",
  "homepage",
  "dependencyNotes",
  "compatibilityNotes",
  "notes",
  "knownGoodVersion",
  "preferredConfigPolicy",
];
const ARRAY_FIELDS = ["aliases"];
const CONFIG_POLICIES = ["KEEP_EXISTING", "USE_NEW_DEFAULT", "REVIEW_CHANGES"];

function root(dataRoot) {
  return path.join(dataRoot, "mod-knowledge");
}

function filePath(dataRoot) {
  return path.join(root(dataRoot), "userKnowledge.json");
}

function emptyDb() {
  return { schemaVersion: SCHEMA_VERSION, mods: {} };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const entry = {};
  for (const field of STRING_FIELDS) {
    if (raw[field] != null && String(raw[field]).trim() !== "") entry[field] = String(raw[field]).trim();
  }
  for (const field of ARRAY_FIELDS) {
    if (Array.isArray(raw[field])) {
      const list = raw[field].map((v) => String(v).trim()).filter(Boolean);
      if (list.length) entry[field] = list;
    }
  }
  if (entry.preferredConfigPolicy && !CONFIG_POLICIES.includes(entry.preferredConfigPolicy)) {
    delete entry.preferredConfigPolicy;
  }
  if (raw.updatedAt) entry.updatedAt = String(raw.updatedAt);
  return Object.keys(entry).length ? entry : null;
}

function load(dataRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(dataRoot), "utf8"));
    const mods = {};
    const source = raw && typeof raw.mods === "object" && raw.mods ? raw.mods : {};
    for (const [key, value] of Object.entries(source)) {
      const entry = normalizeEntry(value);
      if (entry) mods[key] = entry;
    }
    return { schemaVersion: SCHEMA_VERSION, mods };
  } catch {
    return emptyDb();
  }
}

function save(dataRoot, db) {
  fs.mkdirSync(root(dataRoot), { recursive: true });
  const clean = { schemaVersion: SCHEMA_VERSION, mods: {} };
  for (const [key, value] of Object.entries((db && db.mods) || {})) {
    const entry = normalizeEntry(value);
    if (entry) clean.mods[key] = entry;
  }
  const tmp = `${filePath(dataRoot)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath(dataRoot));
  return clean;
}

// installId is the primary key; canonicalModId is an alternate so overrides
// (especially knownGoodVersion) survive a reinstall with a fresh installId.
function getEntry(dataRoot, { installId = "", canonicalModId = "" } = {}) {
  const db = load(dataRoot);
  if (installId && db.mods[installId]) return { key: installId, ...db.mods[installId] };
  if (canonicalModId && db.mods[canonicalModId]) return { key: canonicalModId, ...db.mods[canonicalModId] };
  return null;
}

function setEntry(dataRoot, key, patch) {
  if (!key) throw new Error("A mod key is required.");
  const db = load(dataRoot);
  const existing = db.mods[key] || {};
  const merged = normalizeEntry({ ...existing, ...patch }) || {};
  // Allow clearing a field by passing an empty string explicitly.
  for (const field of [...STRING_FIELDS, ...ARRAY_FIELDS]) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, field)) {
      const value = patch[field];
      const empty = value == null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
      if (empty) delete merged[field];
    }
  }
  merged.updatedAt = new Date().toISOString();
  db.mods[key] = merged;
  save(dataRoot, db);
  return { key, ...merged };
}

function removeEntry(dataRoot, key) {
  const db = load(dataRoot);
  if (db.mods[key]) {
    delete db.mods[key];
    save(dataRoot, db);
  }
  return true;
}

function markKnownGoodVersion(dataRoot, key, version) {
  return setEntry(dataRoot, key, { knownGoodVersion: String(version || "").trim() });
}

// Resolve a single field across the tiered sources. `sources` is a partial
// map of tier -> value. Returns the winning value and its source tier.
function resolveField(field, sources = {}) {
  for (const tier of PRIORITY) {
    if (tier === "UNKNOWN") break;
    const bucket = sources[SOURCE_BY_TIER[tier]];
    if (!bucket) continue;
    const value = bucket[field];
    if (value == null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return { value, source: tier, userProvided: tier === "USER_OVERRIDE" };
  }
  return { value: null, source: "UNKNOWN", userProvided: false };
}

// Merge a managed mod with knowledge into a display view. Marks which fields
// were user-provided so the UI can label them clearly.
function resolveMod({ mod = {}, userEntry = null, builtIn = null, readme = null } = {}) {
  const localVerified = {
    displayName: mod.name,
    version: mod.version,
    category: mod.category,
    author: Array.isArray(mod.authors) ? mod.authors[0] : mod.author,
  };
  const sources = {
    user: userEntry || {},
    localVerified,
    builtIn: builtIn
      ? {
          displayName: builtIn.name,
          aliases: builtIn.aliases,
          author: (builtIn.authors || [])[0],
          category: builtIn.category,
        }
      : {},
    readme: readme || {},
  };

  const view = {};
  const provenance = {};
  for (const field of ["displayName", "author", "category", "aliases", "homepage", "compatibilityNotes", "dependencyNotes", "notes"]) {
    const resolved = resolveField(field, sources);
    view[field] = resolved.value;
    provenance[field] = { source: resolved.source, userProvided: resolved.userProvided };
  }

  // Version: a user override wins, otherwise the locally detected version.
  const versionResolved = resolveField("versionOverride", { user: userEntry || {} });
  view.version = versionResolved.value || mod.version || "UNKNOWN";
  provenance.version = {
    source: versionResolved.value ? "USER_OVERRIDE" : "LOCAL_VERIFIED_DATA",
    userProvided: Boolean(versionResolved.value),
  };

  view.knownGoodVersion = (userEntry && userEntry.knownGoodVersion) || null;
  view.preferredConfigPolicy = (userEntry && userEntry.preferredConfigPolicy) || null;
  view.installId = mod.installId || mod.id || null;
  view.canonicalModId = mod.canonicalModId || null;
  view.provenance = provenance;
  view.hasUserOverride = Boolean(userEntry && Object.keys(userEntry).some((k) => k !== "key" && k !== "updatedAt"));
  return view;
}

module.exports = {
  SCHEMA_VERSION,
  PRIORITY,
  STRING_FIELDS,
  ARRAY_FIELDS,
  CONFIG_POLICIES,
  root,
  filePath,
  emptyDb,
  load,
  save,
  getEntry,
  setEntry,
  removeEntry,
  markKnownGoodVersion,
  resolveField,
  resolveMod,
};
