const { SCHEMA_VERSION } = require("../manifestValidate");
const { BACKEND_METHODS, MOCK_CAPABILITIES, REAL_READONLY_CAPABILITIES, isRealRpfPath, assertBackendContract } = require("./archiveBackend");
const { ENABLE_NATIVE_ARCHIVE_WRITES, nativeArchiveWritesEnabled } = require("./archiveFlags");
const { CODES, ArchiveError } = require("./archiveErrors");
const mock = require("./mockArchiveBackend");
const real = require("./realRpfBackend");
const { hashOfFile } = require("./rpf7OpenReader");
const ownership = require("./archiveOwnership");
const {
  STATES,
  createPlan,
  applyPlan,
  applyOwnerRelease,
  describeOperations,
  listTransactions,
  loadTransaction,
} = require("./archiveTransaction");
const { scanRecovery, recover, recoverAll } = require("./archiveRecovery");

assertBackendContract(mock);
assertBackendContract(real);

function getCapabilities() {
  return {
    ...REAL_READONLY_CAPABILITIES,
    writeEnabled: false,
    nativeWritesEnabled: nativeArchiveWritesEnabled(),
    backend: real.BACKEND_ID,
    version: real.BACKEND_VERSION,
    mode: "READ_ONLY",
    mock: { ...MOCK_CAPABILITIES },
    real: { ...REAL_READONLY_CAPABILITIES },
  };
}

function getBackendHealth() {
  return real.getHealth();
}

function selectBackend(archivePath, options = {}) {
  if (isRealRpfPath(archivePath)) {
    return real;
  }
  return mock;
}

function openArchive(archivePath, options = {}) {
  const opts = isRealRpfPath(archivePath) ? { mode: "readOnly", ...options } : options;
  return selectBackend(archivePath, opts).openArchive(archivePath, opts);
}

function inspectEntry(dataDir, archivePath, entryPath) {
  const handle = openArchive(archivePath, { readOnly: true, mode: "readOnly" });
  const backend = handle.backend === real.BACKEND_ID ? real : mock;
  try {
    const meta = backend.getEntryMetadata(handle, entryPath);
    const record = ownership.getRecord(ownership.loadOwnership(dataDir), handle.name, String(entryPath || "").replace(/\\/g, "/"));
    const inspect = ownership.inspectRecord(record, meta.hash);
    return {
      archive: handle.name,
      entry: meta.path,
      exists: meta.exists,
      hash: meta.hash,
      currentOwner: inspect.currentOwner,
      status: inspect.status,
      history: record ? record.history.map((row) => ({ owner: row.owner, hash: row.hash, absent: !!row.absent })) : [],
    };
  } finally {
    backend.close(handle);
  }
}

function withArchiveOperations(manifest, txOrOps) {
  const extra = Array.isArray(txOrOps) ? txOrOps : describeOperations(txOrOps);
  return {
    ...manifest,
    schemaVersion: manifest.schemaVersion || SCHEMA_VERSION,
    archiveOperations: [...(manifest.archiveOperations || []), ...extra],
  };
}

module.exports = {
  BACKEND_METHODS,
  STATES,
  CODES,
  ArchiveError,
  ENABLE_NATIVE_ARCHIVE_WRITES,
  getCapabilities,
  getBackendHealth,
  selectBackend,
  openArchive,
  listEntries: (handle) => (handle.backend === real.BACKEND_ID ? real.listEntries(handle) : mock.listEntries(handle)),
  entryExists: (handle, entry) =>
    handle.backend === real.BACKEND_ID ? real.entryExists(handle, entry) : mock.entryExists(handle, entry),
  readEntry: (handle, entry) =>
    handle.backend === real.BACKEND_ID ? real.readEntry(handle, entry) : mock.readEntry(handle, entry),
  getEntryMetadata: (handle, entry) =>
    handle.backend === real.BACKEND_ID ? real.getEntryMetadata(handle, entry) : mock.getEntryMetadata(handle, entry),
  addEntry: (handle, entry, bytes) =>
    handle.backend === real.BACKEND_ID ? real.addEntry(handle, entry, bytes) : mock.addEntry(handle, entry, bytes),
  replaceEntry: (handle, entry, bytes) =>
    handle.backend === real.BACKEND_ID ? real.replaceEntry(handle, entry, bytes) : mock.replaceEntry(handle, entry, bytes),
  removeEntry: (handle, entry) =>
    handle.backend === real.BACKEND_ID ? real.removeEntry(handle, entry) : mock.removeEntry(handle, entry),
  validate: (handle) => (handle.backend === real.BACKEND_ID ? real.validate(handle) : mock.validate(handle)),
  commit: (handle) => (handle.backend === real.BACKEND_ID ? real.commit(handle) : mock.commit(handle)),
  close: (handle) => (handle.backend === real.BACKEND_ID ? real.close(handle) : mock.close(handle)),
  hashArchive: (handle) => (handle.backend === real.BACKEND_ID ? hashOfFile(handle.path) : mock.hashOfHandle(handle)),
  archiveIdentity: mock.identityOfHandle,
  writeMockArchive: mock.writeMockArchive,
  computeArchiveHash: mock.computeArchiveHash,
  createPlan,
  applyPlan,
  applyOwnerRelease,
  inspectEntry,
  loadOwnership: ownership.loadOwnership,
  getOwnershipRecord: ownership.getRecord,
  VANILLA: ownership.VANILLA,
  ownershipEquals: ownership.ownershipEquals,
  cloneOwnership: ownership.cloneOwnership,
  scanRecovery,
  recover,
  recoverAll,
  listTransactions,
  loadTransaction,
  withArchiveOperations,
  describeOperations,
  nativeArchiveWritesEnabled,
};
