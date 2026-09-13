const fs = require("fs");
const path = require("path");

// Local in-game evidence only. Never writes built-in catalog compatibility.
// Source is always LOCAL_VERIFIED_DATA — not global VERIFIED.

const SCHEMA_VERSION = 1;
const STATUSES = { WORKED: "WORKED", FAILED: "FAILED" };
const PROCESSED_KEEP = 80;

function root(dataRoot) {
  return path.join(dataRoot, "mod-knowledge");
}

function filePath(dataRoot) {
  return path.join(root(dataRoot), "runtimeEvidence.json");
}

function emptyDb() {
  return { schemaVersion: SCHEMA_VERSION, processedSessions: {}, mods: {}, history: {} };
}

function normalizeRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const status = String(raw.status || "").toUpperCase();
  if (status !== STATUSES.WORKED && status !== STATUSES.FAILED) return null;
  const installId = String(raw.installId || "").trim();
  if (!installId) return null;
  return {
    installId,
    canonicalModId: raw.canonicalModId ? String(raw.canonicalModId).trim() : null,
    status,
    kind: raw.kind ? String(raw.kind).trim() : "",
    sessionId: raw.sessionId ? String(raw.sessionId) : null,
    at: raw.at ? String(raw.at) : null,
    evidence: raw.evidence ? String(raw.evidence).trim().slice(0, 240) : "",
    source: "LOCAL_VERIFIED_DATA",
    version: raw.version ? String(raw.version) : "",
    hash: raw.hash ? String(raw.hash) : "",
    confidence: raw.confidence ? String(raw.confidence) : "",
    ruleTier: raw.ruleTier ? String(raw.ruleTier) : "",
  };
}

function load(dataRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(dataRoot), "utf8"));
    const mods = {};
    const source = raw && typeof raw.mods === "object" && raw.mods ? raw.mods : {};
    for (const [key, value] of Object.entries(source)) {
      const row = normalizeRow({ ...value, installId: value.installId || key });
      if (row) mods[key] = row;
    }
    const processedSessions =
      raw && typeof raw.processedSessions === "object" && raw.processedSessions ? { ...raw.processedSessions } : {};
    const history = raw && typeof raw.history === "object" && raw.history ? raw.history : {};
    return { schemaVersion: SCHEMA_VERSION, processedSessions, mods, history };
  } catch {
    return emptyDb();
  }
}

function pruneProcessed(processed) {
  const entries = Object.entries(processed || {}).sort((a, b) => String(b[1]).localeCompare(String(a[1])));
  return Object.fromEntries(entries.slice(0, PROCESSED_KEEP));
}

function save(dataRoot, db) {
  fs.mkdirSync(root(dataRoot), { recursive: true });
  const clean = { schemaVersion: SCHEMA_VERSION, processedSessions: pruneProcessed(db && db.processedSessions), mods: {}, history: {} };
  for (const [key, value] of Object.entries((db && db.mods) || {})) {
    const row = normalizeRow(value);
    if (row) clean.mods[key] = row;
  }
  if (db && db.history && typeof db.history === "object") clean.history = db.history;
  const tmp = `${filePath(dataRoot)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath(dataRoot));
  return clean;
}

function matchesFingerprint(row, mod = {}) {
  if (!row) return false;
  const version = String(mod.version || "").trim();
  const hash = String((mod.sourceArchiveHash || (mod.files && mod.files[0] && mod.files[0].hash) || "").trim());
  if (row.version && version && row.version !== "UNKNOWN" && version !== "UNKNOWN" && row.version !== version) return false;
  if (row.hash && hash && row.hash !== hash) return false;
  return true;
}

function lookup(db, mod = {}) {
  const installId = mod.id || mod.installId;
  const canonical = mod.canonicalModId;
  let row = null;
  if (installId && db && db.mods && db.mods[installId]) row = db.mods[installId];
  else if (canonical && db && db.mods) {
    for (const item of Object.values(db.mods)) {
      if (item.canonicalModId && item.canonicalModId === canonical) {
        row = item;
        break;
      }
    }
  }
  if (row && !matchesFingerprint(row, mod)) return null;
  return row;
}

function bumpHistory(db, installId, version, status) {
  if (!db || !installId) return;
  if (!db.history) db.history = {};
  const ver = String(version || "UNKNOWN");
  if (!db.history[installId]) db.history[installId] = {};
  if (!db.history[installId][ver]) db.history[installId][ver] = { worked: 0, failed: 0 };
  if (status === STATUSES.WORKED) db.history[installId][ver].worked += 1;
  if (status === STATUSES.FAILED) db.history[installId][ver].failed += 1;
}

function versionHistory(db, installId) {
  const rows = (db && db.history && db.history[installId]) || {};
  return Object.entries(rows).map(([version, counts]) => ({
    version,
    worked: Number(counts.worked) || 0,
    failed: Number(counts.failed) || 0,
  }));
}

function getEvidence(dataRoot, mod) {
  return lookup(load(dataRoot), mod);
}

function upsertRow(db, patch) {
  const row = normalizeRow({
    ...patch,
    at: (patch && patch.at) || new Date().toISOString(),
  });
  if (!row || !db) return null;
  db.mods[row.installId] = row;
  return row;
}

function sessionProcessed(db, sessionId) {
  return Boolean(sessionId && db && db.processedSessions && db.processedSessions[sessionId]);
}

function markSessionProcessed(db, sessionId) {
  if (!sessionId || !db) return;
  db.processedSessions[sessionId] = new Date().toISOString();
}

module.exports = {
  SCHEMA_VERSION,
  STATUSES,
  filePath,
  emptyDb,
  load,
  save,
  lookup,
  getEvidence,
  upsertRow,
  sessionProcessed,
  markSessionProcessed,
  matchesFingerprint,
  bumpHistory,
  versionHistory,
};
