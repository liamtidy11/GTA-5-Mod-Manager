const fs = require("fs");
const path = require("path");
const { SCHEMA_VERSION } = require("./snapshotTypes");
const { atomicWrite } = require("../profiles/managedState");

function indexPath(root) {
  return path.join(root, "index.json");
}

function snapshotFile(root, snapshotId) {
  return path.join(root, `${snapshotId}.json`);
}

function snapshotDir(root, snapshotId) {
  return path.join(root, snapshotId);
}

function blobRoot(root) {
  return path.join(root, "blobs");
}

function payloadRoot(root, snapshotId) {
  return path.join(snapshotDir(root, snapshotId), "payloads");
}

function emptyIndex() {
  return { schemaVersion: SCHEMA_VERSION, snapshots: [] };
}

function loadIndex(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(root), "utf8"));
    return { schemaVersion: SCHEMA_VERSION, snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : [] };
  } catch {
    return emptyIndex();
  }
}

function saveIndex(root, index) {
  atomicWrite(indexPath(root), `${JSON.stringify(index, null, 2)}\n`);
}

function toIndexRow(snapshot) {
  return {
    snapshotId: snapshot.snapshotId,
    name: snapshot.name,
    createdAt: snapshot.createdAt,
    reason: snapshot.reason,
    pinned: Boolean(snapshot.pinned),
    knownGood: Boolean(snapshot.knownGood),
    modCount: Array.isArray(snapshot.mods) ? snapshot.mods.length : 0,
  };
}

function writeSnapshot(root, snapshot) {
  atomicWrite(snapshotFile(root, snapshot.snapshotId), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...snapshot }, null, 2)}\n`);
  const index = loadIndex(root);
  const next = index.snapshots.filter((row) => row.snapshotId !== snapshot.snapshotId);
  next.unshift(toIndexRow(snapshot));
  index.snapshots = next;
  saveIndex(root, index);
  return snapshot;
}

function getSnapshot(root, snapshotId) {
  try {
    return JSON.parse(fs.readFileSync(snapshotFile(root, snapshotId), "utf8"));
  } catch {
    return null;
  }
}

function deleteSnapshot(root, snapshotId) {
  try {
    fs.rmSync(snapshotFile(root, snapshotId), { force: true });
    fs.rmSync(snapshotDir(root, snapshotId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const index = loadIndex(root);
  index.snapshots = index.snapshots.filter((row) => row.snapshotId !== snapshotId);
  saveIndex(root, index);
}

function listSnapshots(root) {
  return loadIndex(root).snapshots.map((row) => getSnapshot(root, row.snapshotId)).filter(Boolean);
}

module.exports = {
  indexPath,
  snapshotFile,
  snapshotDir,
  blobRoot,
  payloadRoot,
  loadIndex,
  saveIndex,
  writeSnapshot,
  getSnapshot,
  deleteSnapshot,
  listSnapshots,
};
