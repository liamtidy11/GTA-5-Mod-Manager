const fs = require("fs");
const path = require("path");
const { SCHEMA_VERSION, RETENTION, TERMINAL_STATES } = require("./sessionTypes");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

function indexPath(root) {
  return path.join(root, "index.json");
}

function sessionDir(root, sessionId) {
  return path.join(root, sessionId);
}

function sessionFile(root, sessionId) {
  return path.join(sessionDir(root, sessionId), "session.json");
}

function emptyIndex() {
  return { schemaVersion: SCHEMA_VERSION, sessions: [] };
}

function loadIndex(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(root), "utf8"));
    return { schemaVersion: SCHEMA_VERSION, sessions: Array.isArray(raw.sessions) ? raw.sessions : [] };
  } catch {
    return emptyIndex();
  }
}

function saveIndex(root, index) {
  ensureDir(root);
  atomicWrite(indexPath(root), JSON.stringify(index, null, 2));
}

function toIndexRow(session) {
  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    endedAt: session.endedAt || null,
    durationMs: session.durationMs == null ? null : session.durationMs,
    state: session.state,
    result: session.result,
    confidence: session.confidence,
    enabledModCount: Array.isArray(session.mods) ? session.mods.filter((m) => m.enabled).length : 0,
    installIds: (session.mods || []).map((m) => m.installId).filter(Boolean),
    incomplete: Boolean(session.incomplete),
  };
}

function upsertIndex(root, session) {
  const index = loadIndex(root);
  const row = toIndexRow(session);
  const next = index.sessions.filter((item) => item.sessionId !== session.sessionId);
  next.unshift(row);
  next.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  index.sessions = next;
  saveIndex(root, index);
  return index;
}

function createSession(root, session) {
  ensureDir(sessionDir(root, session.sessionId));
  ensureDir(path.join(sessionDir(root, session.sessionId), "logs"));
  const record = { schemaVersion: SCHEMA_VERSION, ...session };
  atomicWrite(sessionFile(root, session.sessionId), JSON.stringify(record, null, 2));
  upsertIndex(root, record);
  prune(root);
  return record;
}

function getSession(root, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(root, sessionId), "utf8"));
  } catch {
    return null;
  }
}

function updateSession(root, sessionId, patch) {
  const current = getSession(root, sessionId);
  if (!current) return null;
  const next = { ...current, ...patch };
  if (patch.timeline) next.timeline = patch.timeline;
  atomicWrite(sessionFile(root, sessionId), JSON.stringify(next, null, 2));
  upsertIndex(root, next);
  return next;
}

function finalizeSession(root, sessionId, patch) {
  return updateSession(root, sessionId, { incomplete: false, ...patch });
}

function listSessions(root) {
  return loadIndex(root).sessions;
}

function getLatestSession(root) {
  const rows = listSessions(root);
  if (!rows.length) return null;
  return getSession(root, rows[0].sessionId);
}

function getRecentSessions(root, limit = 20) {
  return listSessions(root).slice(0, limit);
}

function getSuccessfulSessions(root, limit = 20) {
  return listSessions(root)
    .filter((row) => row.result === "CLEAN_EXIT")
    .slice(0, limit);
}

function getFailedSessions(root, limit = 20) {
  return listSessions(root)
    .filter((row) => ["GAME_CRASH", "RPH_CRASH", "LSPDFR_CRASH", "LAUNCH_FAILED"].includes(row.result))
    .slice(0, limit);
}

function getSessionsForMod(root, installId) {
  const needle = String(installId || "");
  return listSessions(root).filter((row) => (row.installIds || []).includes(needle));
}

function prune(root, keep = RETENTION) {
  const index = loadIndex(root);
  if (index.sessions.length <= keep) return index;
  const removed = index.sessions.slice(keep);
  index.sessions = index.sessions.slice(0, keep);
  saveIndex(root, index);
  for (const row of removed) {
    try {
      fs.rmSync(sessionDir(root, row.sessionId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return index;
}

function listIncomplete(root) {
  return listSessions(root).filter((row) => row.incomplete || !TERMINAL_STATES.has(row.state));
}

module.exports = {
  indexPath,
  sessionDir,
  sessionFile,
  loadIndex,
  createSession,
  updateSession,
  finalizeSession,
  getSession,
  listSessions,
  getLatestSession,
  getRecentSessions,
  getSuccessfulSessions,
  getFailedSessions,
  getSessionsForMod,
  prune,
  listIncomplete,
};
