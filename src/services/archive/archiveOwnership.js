const fs = require("fs");
const path = require("path");
const { ArchiveError, CODES } = require("./archiveErrors");
const { storeEntry, entryBytes, entryHash } = require("./mockArchiveBackend");

const VANILLA = "VANILLA";

function ownershipPath(dataDir) {
  return path.join(dataDir, "archive-ownership.json");
}

function emptyStore() {
  return { schemaVersion: 1, entries: {} };
}

function loadOwnership(dataDir) {
  if (!dataDir) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(ownershipPath(dataDir), "utf8"));
    if (!raw || typeof raw !== "object") return emptyStore();
    return {
      schemaVersion: 1,
      entries: raw.entries && typeof raw.entries === "object" ? raw.entries : {},
    };
  } catch {
    return emptyStore();
  }
}

function saveOwnership(dataDir, store) {
  if (!dataDir) return store;
  fs.mkdirSync(dataDir, { recursive: true });
  const payload = { schemaVersion: 1, entries: (store && store.entries) || {} };
  fs.writeFileSync(ownershipPath(dataDir), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function cloneOwnership(store) {
  return JSON.parse(JSON.stringify(store || emptyStore()));
}

function ownershipKey(archiveName, entryPath) {
  return `${archiveName}::${String(entryPath || "").replace(/\\/g, "/")}`;
}

function getRecord(store, archiveName, entryPath) {
  return store.entries[ownershipKey(archiveName, entryPath)] || null;
}

function ensureRecord(store, archiveName, entryPath) {
  const key = ownershipKey(archiveName, entryPath);
  if (!store.entries[key]) {
    store.entries[key] = {
      archive: archiveName,
      entry: entryPath,
      currentOwner: VANILLA,
      status: "OK",
      history: [],
    };
  }
  return store.entries[key];
}

function layerFromBytes(owner, bytesOrNull) {
  if (bytesOrNull == null) {
    return { owner, hash: null, absent: true, encoding: "utf8", data: "" };
  }
  const stored = storeEntry(bytesOrNull);
  return {
    owner,
    hash: entryHash(stored),
    absent: false,
    encoding: stored.encoding,
    data: stored.data,
  };
}

function layerContent(layer) {
  if (!layer || layer.absent) return null;
  return entryBytes(layer);
}

function expectedHashForOwner(record, owner) {
  if (!record) return null;
  const layers = (record.history || []).filter((row) => row.owner === owner);
  const last = layers[layers.length - 1];
  if (!last || last.absent) return null;
  return last.hash;
}

function inspectRecord(record, liveHash) {
  if (!record || !record.currentOwner || record.currentOwner === VANILLA) {
    return { status: "OK", currentOwner: (record && record.currentOwner) || VANILLA, expectedHash: null };
  }
  const expectedHash = expectedHashForOwner(record, record.currentOwner);
  if (liveHash !== expectedHash) {
    return { status: "EXTERNALLY_MODIFIED", currentOwner: record.currentOwner, expectedHash, liveHash };
  }
  return { status: "OK", currentOwner: record.currentOwner, expectedHash, liveHash };
}

function assertNotExternallyModified(record, liveHash, entryPath) {
  const inspect = inspectRecord(record, liveHash);
  if (inspect.status === "EXTERNALLY_MODIFIED") {
    if (record) record.status = "EXTERNALLY_MODIFIED";
    throw new ArchiveError(
      CODES.EXTERNALLY_MODIFIED,
      "Archive entry was modified outside the manager.",
      { file: entryPath, whatToDo: "Re-analyse the archive. The manager will not overwrite an external change." }
    );
  }
  return inspect;
}

function recordVanillaIfNeeded(store, archiveName, entryPath, currentBytes) {
  const record = ensureRecord(store, archiveName, entryPath);
  if (!record.history.length) {
    record.history.push(layerFromBytes(VANILLA, currentBytes));
    record.currentOwner = VANILLA;
    record.status = "OK";
  }
  return record;
}

function pushOwner(store, archiveName, entryPath, installId, newBytes, previousBytes) {
  const record = recordVanillaIfNeeded(store, archiveName, entryPath, previousBytes);
  const liveHash = previousBytes == null ? null : entryHash(storeEntry(previousBytes));
  if (record.currentOwner && record.currentOwner !== VANILLA) {
    assertNotExternallyModified(record, liveHash, entryPath);
  }
  const layer = layerFromBytes(installId, newBytes);
  if (record.currentOwner === installId) {
    const last = record.history[record.history.length - 1];
    if (last && last.owner === installId) record.history[record.history.length - 1] = layer;
    else record.history.push(layer);
  } else {
    record.history.push(layer);
  }
  record.currentOwner = installId;
  record.status = "OK";
  return record;
}

function releaseOwner(store, archiveName, entryPath, installId) {
  const record = getRecord(store, archiveName, entryPath);
  if (!record) return { action: "NONE", record: null, restore: null };
  const wasCurrent = record.currentOwner === installId;
  record.history = (record.history || []).filter((row) => row.owner !== installId);
  if (!wasCurrent) {
    return { action: "FORGET_LAYER", record, restore: null };
  }
  const previous = record.history[record.history.length - 1] || layerFromBytes(VANILLA, null);
  record.currentOwner = previous.owner;
  record.status = "OK";
  return { action: "RESTORE", record, restore: previous };
}

function ownershipEquals(a, b) {
  return JSON.stringify(cloneOwnership(a)) === JSON.stringify(cloneOwnership(b));
}

module.exports = {
  VANILLA,
  ownershipPath,
  emptyStore,
  loadOwnership,
  saveOwnership,
  cloneOwnership,
  ownershipKey,
  getRecord,
  ensureRecord,
  layerFromBytes,
  layerContent,
  expectedHashForOwner,
  inspectRecord,
  assertNotExternallyModified,
  recordVanillaIfNeeded,
  pushOwner,
  releaseOwner,
  ownershipEquals,
};
