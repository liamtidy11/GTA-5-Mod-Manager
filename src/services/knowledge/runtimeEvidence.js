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
  return { schemaVersion: SCHEMA_VERSION, processedSessions: {}, mods: {} };
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
    return { schemaVersion: SCHEMA_VERSION, processedSessions, mods };
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
  const clean = { schemaVersion: SCHEMA_VERSION, processedSessions: pruneProcessed(db && db.processedSessions), mods: {} };
  for (const [key, value] of Object.entries((db && db.mods) || {})) {
    const row = normalizeRow(value);
    if (row) clean.mods[key] = row;
  }
  const tmp = `${filePath(dataRoot)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath(dataRoot));
  return clean;
}

function lookup(db, mod = {}) {
  const installId = mod.id || mod.installId;
  const canonical = mod.canonicalModId;
  if (installId && db && db.mods && db.mods[installId]) return db.mods[installId];
  if (canonical && db && db.mods) {
    for (const row of Object.values(db.mods)) {
      if (row.canonicalModId && row.canonicalModId === canonical) return row;
    }
  }
  return null;
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
};
