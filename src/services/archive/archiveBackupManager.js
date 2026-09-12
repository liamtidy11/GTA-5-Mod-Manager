const fs = require("fs");
const path = require("path");
const { serializeArchive, computeArchiveHash, archiveByteSize } = require("./mockArchiveBackend");
const { cloneOwnership } = require("./archiveOwnership");

function backupDir(dataDir, transactionId) {
  return path.join(dataDir, "archive-backups", transactionId);
}

function createBackup({ dataDir, archiveTransactionId, handle, ownershipStore }) {
  const dir = backupDir(dataDir, archiveTransactionId);
  fs.mkdirSync(dir, { recursive: true });
  const archiveCopy = path.join(dir, "archive.json");
  fs.writeFileSync(archiveCopy, serializeArchive(handle.archive), "utf8");
  const ownershipCopy = path.join(dir, "ownership.json");
  fs.writeFileSync(ownershipCopy, JSON.stringify(cloneOwnership(ownershipStore), null, 2), "utf8");
  const meta = {
    archiveOriginalHash: computeArchiveHash(handle.archive),
    archiveOriginalSize: archiveByteSize(handle.archive),
    backupPath: dir,
    createdAt: new Date().toISOString(),
    transactionId: archiveTransactionId,
    archivePath: handle.path,
    archiveName: handle.name,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

function readBackupMeta(dataDir, transactionId) {
  const metaPath = path.join(backupDir(dataDir, transactionId), "meta.json");
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

function restoreArchiveFile(meta) {
  const archiveCopy = path.join(meta.backupPath, "archive.json");
  const dest = meta.archivePath;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(archiveCopy, dest);
  return dest;
}

function restoreOwnershipSnapshot(meta) {
  try {
    return JSON.parse(fs.readFileSync(path.join(meta.backupPath, "ownership.json"), "utf8"));
  } catch {
    return { schemaVersion: 1, entries: {} };
  }
}

module.exports = {
  backupDir,
  createBackup,
  readBackupMeta,
  restoreArchiveFile,
  restoreOwnershipSnapshot,
};
