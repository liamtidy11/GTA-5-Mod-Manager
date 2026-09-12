const fs = require("fs");
const path = require("path");
const { ACTION_SCHEMA_VERSION, ACTION_STATES, PENDING_STATES } = require("./crashActionTypes");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

function actionPath(root, actionId) {
  return path.join(root, `${actionId}.json`);
}

function indexPath(root) {
  return path.join(root, "index.json");
}

function loadIndex(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(root), "utf8"));
    return { schemaVersion: ACTION_SCHEMA_VERSION, actions: Array.isArray(raw.actions) ? raw.actions : [] };
  } catch {
    return { schemaVersion: ACTION_SCHEMA_VERSION, actions: [] };
  }
}

function toIndexRow(action) {
  return {
    actionId: action.actionId,
    type: action.type,
    state: action.state,
    sessionId: action.sessionId || "",
    retestSessionId: action.retestSessionId || "",
    installId: action.installId || "",
    createdAt: action.createdAt,
    reversible: action.reversible !== false,
  };
}

function saveIndex(root, index) {
  ensureDir(root);
  atomicWrite(indexPath(root), `${JSON.stringify(index, null, 2)}\n`);
}

function writeAction(root, action) {
  ensureDir(root);
  const record = { schemaVersion: ACTION_SCHEMA_VERSION, ...action };
  atomicWrite(actionPath(root, record.actionId), `${JSON.stringify(record, null, 2)}\n`);
  const index = loadIndex(root);
  const next = index.actions.filter((row) => row.actionId !== record.actionId);
  next.unshift(toIndexRow(record));
  index.actions = next.slice(0, 200);
  saveIndex(root, index);
  return record;
}

function getAction(root, actionId) {
  try {
    return JSON.parse(fs.readFileSync(actionPath(root, actionId), "utf8"));
  } catch {
    return null;
  }
}

function listActions(root, limit = 40) {
  return loadIndex(root).actions.slice(0, limit);
}

function actionsForSession(root, sessionId) {
  return listActions(root, 200)
    .filter((row) => row.sessionId === sessionId)
    .map((row) => getAction(root, row.actionId))
    .filter(Boolean);
}

function pendingActions(root) {
  return listActions(root, 200)
    .filter((row) => PENDING_STATES.has(row.state))
    .map((row) => getAction(root, row.actionId))
    .filter(Boolean);
}

function latestPending(root) {
  return pendingActions(root)[0] || null;
}

function snapshotDir(root, actionId) {
  return path.join(root, actionId, "snapshot");
}

module.exports = {
  actionPath,
  snapshotDir,
  writeAction,
  getAction,
  listActions,
  actionsForSession,
  pendingActions,
  latestPending,
  ACTION_STATES,
};
