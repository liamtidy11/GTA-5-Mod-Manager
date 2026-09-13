const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;
const TIERS = ["USER_OVERRIDE", "LOCAL_VERIFIED", "BUILT_IN", "GENERIC_PLUGIN", "GENERIC_FRAMEWORK", "UNVERIFIED"];
const MATCH_MODES = ["PRIMARY", "ANY", "ALL"];
const MAX_CONTAINS = 200;
const MIN_CONTAINS = 8;

function filePath(dataRoot) {
  return path.join(dataRoot, "mod-knowledge", "runtimeRules.json");
}

function emptyDb() {
  return { schemaVersion: SCHEMA_VERSION, rules: {} };
}

function sanitizeContains(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length < MIN_CONTAINS || text.length > MAX_CONTAINS) return "";
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return "";
  return text;
}

function normalizeSignal(raw) {
  if (!raw || typeof raw !== "object") return null;
  const contains = sanitizeContains(raw.contains);
  if (!contains) return null;
  return {
    type: String(raw.type || "USER_LINE").toUpperCase(),
    source: String(raw.source || "DUTY_LOG").toUpperCase(),
    contains,
    match: raw.match === "exact" ? "exact" : "contains",
  };
}

function normalizeRule(raw, key = "") {
  if (!raw || typeof raw !== "object") return null;
  const signals = (Array.isArray(raw.positiveSignals) ? raw.positiveSignals : []).map(normalizeSignal).filter(Boolean);
  if (!signals.length && !raw.allowIndirect) return null;
  const matchMode = MATCH_MODES.includes(String(raw.matchMode || "").toUpperCase())
    ? String(raw.matchMode).toUpperCase()
    : "PRIMARY";
  return {
    id: String(raw.id || raw.installId || raw.canonicalModId || key || "").trim(),
    installId: raw.installId ? String(raw.installId).trim() : "",
    canonicalModId: raw.canonicalModId ? String(raw.canonicalModId).trim() : "",
    source: TIERS.includes(String(raw.source || "").toUpperCase()) ? String(raw.source).toUpperCase() : "USER_OVERRIDE",
    kind: String(raw.kind || "PLUGIN").toUpperCase(),
    matchMode,
    allowIndirect: raw.allowIndirect === true,
    positiveSignals: signals,
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : new Date().toISOString(),
  };
}

function loadBuiltIn() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "runtimeRules.json"), "utf8"));
    return (raw.rules || []).map((row) => normalizeRule({ ...row, source: "BUILT_IN" })).filter(Boolean);
  } catch {
    return [];
  }
}

function loadUser(dataRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(dataRoot), "utf8"));
    const rules = {};
    const source = raw && typeof raw.rules === "object" && raw.rules ? raw.rules : {};
    for (const [key, value] of Object.entries(source)) {
      const rule = normalizeRule(value, key);
      if (rule) rules[key] = rule;
    }
    return { schemaVersion: SCHEMA_VERSION, rules };
  } catch {
    return emptyDb();
  }
}

function saveUser(dataRoot, db) {
  fs.mkdirSync(path.dirname(filePath(dataRoot)), { recursive: true });
  const clean = emptyDb();
  for (const [key, value] of Object.entries((db && db.rules) || {})) {
    const rule = normalizeRule(value, key);
    if (rule) clean.rules[key] = rule;
  }
  const tmp = `${filePath(dataRoot)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath(dataRoot));
  return clean;
}

function ruleKey(mod = {}) {
  return String(mod.id || mod.installId || mod.canonicalModId || "").trim();
}

function findUserRule(db, mod) {
  const rules = (db && db.rules) || {};
  const installId = mod.id || mod.installId;
  const canonical = mod.canonicalModId;
  if (installId && rules[installId]) return rules[installId];
  if (canonical && rules[canonical]) return rules[canonical];
  return null;
}

function findBuiltInRule(mod, builtIn = loadBuiltIn()) {
  const canonical = mod.canonicalModId;
  if (!canonical) return null;
  return builtIn.find((rule) => rule.canonicalModId === canonical) || null;
}

function setUserRule(dataRoot, { installId, canonicalModId, contains, source = "USER_OVERRIDE", match = "contains" } = {}) {
  const signal = normalizeSignal({ contains, match, source: "DUTY_LOG", type: "USER_LINE" });
  if (!signal) throw new Error("That log line is too short or not plain text.");
  const key = String(installId || canonicalModId || "").trim();
  if (!key) throw new Error("A managed mod is required.");
  const db = loadUser(dataRoot);
  db.rules[key] = normalizeRule({
    id: key,
    installId: installId || "",
    canonicalModId: canonicalModId || "",
    source: source === "LOCAL_VERIFIED" ? "LOCAL_VERIFIED" : "USER_OVERRIDE",
    kind: "PLUGIN",
    matchMode: "PRIMARY",
    positiveSignals: [signal],
  });
  saveUser(dataRoot, db);
  return db.rules[key];
}

function clearUserRule(dataRoot, key) {
  const db = loadUser(dataRoot);
  const target = String(key || "").trim();
  if (target && db.rules[target]) delete db.rules[target];
  saveUser(dataRoot, db);
  return true;
}

module.exports = {
  SCHEMA_VERSION,
  TIERS,
  MATCH_MODES,
  filePath,
  sanitizeContains,
  normalizeRule,
  loadBuiltIn,
  loadUser,
  saveUser,
  findUserRule,
  findBuiltInRule,
  setUserRule,
  clearUserRule,
  ruleKey,
};
