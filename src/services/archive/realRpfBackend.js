const fs = require("fs");
const path = require("path");
const { hashBuffer } = require("../hashUtil");
const { ArchiveError, CODES } = require("./archiveErrors");
const { REAL_READONLY_CAPABILITIES, isRealRpfPath } = require("./archiveBackend");
const { ENABLE_NATIVE_ARCHIVE_WRITES } = require("./archiveFlags");
const reader = require("./rpf7OpenReader");

const handles = new Map();
const BACKEND_ID = "first-party-rpf7-open";
const BACKEND_VERSION = "1.0.0-3c";

function capabilities() {
  return {
    ...REAL_READONLY_CAPABILITIES,
    backend: BACKEND_ID,
    version: BACKEND_VERSION,
    writeEnabled: false,
    mode: "READ_ONLY",
  };
}

function refuseWrite(op) {
  throw new ArchiveError(
    CODES.NATIVE_RPF_WRITES_NOT_ENABLED,
    "Native RPF writes are not enabled.",
    { details: op, whatToDo: "Phase 3C is read-only. No real GTA archive will be modified." }
  );
}

function assertUnderRoot(archivePath, root) {
  if (!root) return;
  const resolved = path.resolve(archivePath);
  const base = path.resolve(root);
  const a = resolved.toLowerCase();
  const b = base.toLowerCase();
  if (a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`)) return true;
  return false;
}

function openArchive(archivePath, options = {}) {
  if (ENABLE_NATIVE_ARCHIVE_WRITES === true) {
    refuseWrite("open-write-flag");
  }
  if (options.mode && options.mode !== "readOnly") {
    refuseWrite(options.mode);
  }
  const resolved = path.resolve(archivePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new ArchiveError(CODES.INVALID_RPF, "Archive path does not exist.", { file: resolved });
  }
  if (!isRealRpfPath(resolved)) {
    throw new ArchiveError(CODES.INVALID_RPF, "Archive extension is not .rpf.", { file: resolved });
  }
  if (options.officialPath && assertUnderRoot(resolved, options.officialPath) && options.allowOnlineRead !== true) {
    throw new ArchiveError(CODES.ARCHIVE_READ_ERROR, "Read-only inspection of the Online folder is not used for vehicle discovery.", {
      file: resolved,
    });
  }
  const table = reader.openTable(resolved);
  const handle = {
    id: `real-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    backend: BACKEND_ID,
    path: resolved,
    name: table.name,
    files: table.files,
    encryption: table.encryption,
    size: table.size,
    closed: false,
    readOnly: true,
  };
  handles.set(handle.id, handle);
  return handle;
}

function assertOpen(handle) {
  if (!handle || handle.closed || !handles.has(handle.id)) {
    throw new ArchiveError(CODES.ARCHIVE_READ_ERROR, "Archive handle is closed or invalid.");
  }
}

function listEntries(handle) {
  assertOpen(handle);
  return handle.files.map((f) => f.path);
}

function entryExists(handle, entryPath) {
  assertOpen(handle);
  const key = String(entryPath || "").replace(/\\/g, "/");
  return handle.files.some((f) => f.path === key);
}

function findFile(handle, entryPath) {
  const key = String(entryPath || "").replace(/\\/g, "/");
  return handle.files.find((f) => f.path === key) || null;
}

function readEntry(handle, entryPath) {
  assertOpen(handle);
  const file = findFile(handle, entryPath);
  if (!file) throw new ArchiveError(CODES.ARCHIVE_READ_ERROR, "Archive entry does not exist.", { file: entryPath });
  return reader.readFileBytes(handle.path, file);
}

function getEntryMetadata(handle, entryPath) {
  assertOpen(handle);
  const file = findFile(handle, entryPath);
  if (!file) return { path: String(entryPath || ""), name: "", exists: false, size: 0, hash: null };
  let hash = null;
  try {
    hash = hashBuffer(reader.readFileBytes(handle.path, file));
  } catch {
    hash = null;
  }
  return {
    path: file.path,
    name: file.name,
    exists: true,
    size: file.size || file.compressedSize || 0,
    compressedSize: file.compressedSize || 0,
    type: file.kind,
    hash,
  };
}

function validate(handle) {
  assertOpen(handle);
  if (!handle.files) throw new ArchiveError(CODES.VALIDATION_FAILED, "Archive structure is invalid.");
  return { ok: true, entryCount: handle.files.length, encryption: handle.encryption };
}

function close(handle) {
  if (!handle) return;
  handle.closed = true;
  handles.delete(handle.id);
}

function addEntry() {
  refuseWrite("addEntry");
}
function replaceEntry() {
  refuseWrite("replaceEntry");
}
function removeEntry() {
  refuseWrite("removeEntry");
}
function commit() {
  refuseWrite("commit");
}

function getHealth() {
  return {
    available: true,
    mode: "READ_ONLY",
    backend: BACKEND_ID,
    version: BACKEND_VERSION,
    realGtaArchives: true,
    writeEnabled: false,
    supportedEncryption: ["OPEN", "NONE"],
  };
}

module.exports = {
  BACKEND_ID,
  BACKEND_VERSION,
  capabilities,
  getHealth,
  openArchive,
  listEntries,
  entryExists,
  readEntry,
  getEntryMetadata,
  validate,
  close,
  addEntry,
  replaceEntry,
  removeEntry,
  commit,
};
