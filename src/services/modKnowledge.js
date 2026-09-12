const fs = require("fs");
const path = require("path");

// Built-in recognition catalog. Mutable user knowledge must live outside
// application source (dataDir), never inside src/data.

const BUILTIN_PATH = path.join(__dirname, "..", "data", "modKnowledge.json");

const EMPTY = { schemaVersion: 1, mods: [], source: "EMPTY", warning: "" };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeDependency(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { modId: id, componentId: id, kind: "REQUIRED", version: "", notes: "", incompatible: false } : null;
  }
  const modId = String(raw.modId || raw.id || raw.componentId || "").trim();
  if (!modId) return null;
  const kind = String(raw.kind || "REQUIRED").toUpperCase();
  return {
    modId,
    componentId: String(raw.componentId || raw.modId || raw.id || "").trim() || modId,
    kind: ["REQUIRED", "OPTIONAL", "RECOMMENDED", "UNKNOWN"].includes(kind) ? kind : "REQUIRED",
    version: String(raw.version || "").trim(),
    notes: String(raw.notes || ""),
    incompatible: raw.incompatible === true,
  };
}

const GTA_COMPAT = ["VERIFIED", "LIKELY", "UNKNOWN", "WARNING", "INCOMPATIBLE"];

function normalizeVersionRule(raw) {
  if (!raw || typeof raw !== "object") {
    return { requirement: null, min: null, max: null, exact: null };
  }
  const text = (value) => (value == null || value === "" ? null : String(value));
  return {
    requirement: text(raw.requirement),
    min: text(raw.min),
    max: text(raw.max),
    exact: text(raw.exact),
  };
}

function normalizeCompatibility(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const gta = String(src.gtaEnhanced || "UNKNOWN").toUpperCase();
  return {
    ...src,
    gtaEnhanced: GTA_COMPAT.includes(gta) ? gta : "UNKNOWN",
    lspdfr: normalizeVersionRule(src.lspdfr),
    ragePluginHook: normalizeVersionRule(src.ragePluginHook || src.rph),
  };
}

function normalizeRelation(raw, fallbackSeverity = "HIGH") {
  if (!raw) return null;
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { modId: id, componentId: id, severity: fallbackSeverity, reason: "" } : null;
  }
  const modId = String(raw.modId || raw.id || raw.componentId || "").trim();
  if (!modId) return null;
  return {
    modId,
    componentId: String(raw.componentId || raw.modId || raw.id || "").trim() || modId,
    severity: String(raw.severity || fallbackSeverity).toUpperCase(),
    reason: String(raw.reason || ""),
  };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const name = String(raw.name || "").trim();
  if (!id || !name) return null;
  const recognition = raw.recognition && typeof raw.recognition === "object" ? raw.recognition : {};
  return {
    id,
    name,
    aliases: asArray(raw.aliases).map(String),
    authors: asArray(raw.authors).map(String),
    category: String(raw.category || "UNKNOWN"),
    recognition: {
      dllNames: asArray(recognition.dllNames).map(String),
      archivePatterns: asArray(recognition.archivePatterns).map(String),
      folderPatterns: asArray(recognition.folderPatterns).map(String),
      configNames: asArray(recognition.configNames).map(String),
      readmeTerms: asArray(recognition.readmeTerms).map(String),
    },
    dependencies: asArray(raw.dependencies).map(normalizeDependency).filter(Boolean),
    optionalDependencies: asArray(raw.optionalDependencies).map((d) =>
      normalizeDependency(typeof d === "string" ? { modId: d, kind: "OPTIONAL" } : { ...d, kind: d.kind || "OPTIONAL" })
    ).filter(Boolean),
    conflicts: asArray(raw.conflicts).map((item) => normalizeRelation(item, "HIGH")).filter(Boolean),
    incompatibleWith: asArray(raw.incompatibleWith).map((item) => normalizeRelation(item, "HIGH")).filter(Boolean),
    compatibility: normalizeCompatibility(raw.compatibility),
    notes: asArray(raw.notes).map(String),
  };
}

function parseDatabase(raw, source) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.mods)) {
    return { ...EMPTY, source, warning: "Knowledge database is malformed; using an empty catalog." };
  }
  const mods = [];
  const seen = new Set();
  for (const item of raw.mods) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    mods.push(entry);
  }
  return {
    schemaVersion: Number(raw.schemaVersion) || 1,
    mods,
    source,
    warning: "",
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function load({ builtInPath = BUILTIN_PATH, userPath = "" } = {}) {
  let db = { ...EMPTY, source: "EMPTY" };
  try {
    db = parseDatabase(readJson(builtInPath), "BUILTIN");
  } catch {
    db = { ...EMPTY, source: "EMPTY", warning: "Built-in knowledge database could not be read." };
  }

  if (userPath) {
    try {
      if (fs.existsSync(userPath)) {
        const user = parseDatabase(readJson(userPath), "USER");
        const ids = new Set(db.mods.map((m) => m.id));
        for (const entry of user.mods) {
          if (ids.has(entry.id)) continue;
          db.mods.push(entry);
        }
        if (user.warning) db.warning = user.warning;
      }
    } catch {
      db.warning = "User knowledge database could not be read and was ignored.";
    }
  }

  return db;
}

function findById(db, id) {
  return (db.mods || []).find((m) => m.id === id) || null;
}

module.exports = {
  BUILTIN_PATH,
  load,
  findById,
  parseDatabase,
  normalizeEntry,
  normalizeDependency,
  normalizeCompatibility,
  normalizeRelation,
  GTA_COMPAT,
};
