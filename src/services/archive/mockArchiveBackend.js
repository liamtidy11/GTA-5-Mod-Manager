const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { hashBuffer, hashString } = require("../hashUtil");
const { ArchiveError, CODES } = require("./archiveErrors");
const { MOCK_CAPABILITIES, isRealRpfPath } = require("./archiveBackend");

const KIND = "MOCK_GTA_ARCHIVE";
const handles = new Map();

function capabilities() {
  return { ...MOCK_CAPABILITIES };
}

function rejectRealRpf(archivePath) {
  if (isRealRpfPath(archivePath)) {
    throw new ArchiveError(
      CODES.REAL_ARCHIVE_BACKEND_NOT_AVAILABLE,
      "Real GTA archive backend is not available.",
      { file: String(archivePath || ""), whatToDo: "Use a mock archive fixture. Phase 3A does not open .rpf files." }
    );
  }
}

function normalizeEntryPath(entryPath) {
  const norm = String(entryPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!norm || norm.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new ArchiveError(CODES.ARCHIVE_ERROR, "Invalid archive entry path.", { file: String(entryPath || "") });
  }
  return norm;
}

function toBytes(bytesOrSource) {
  if (Buffer.isBuffer(bytesOrSource)) return bytesOrSource;
  if (typeof bytesOrSource === "string") return Buffer.from(bytesOrSource, "utf8");
  if (bytesOrSource && typeof bytesOrSource === "object") {
    if (Buffer.isBuffer(bytesOrSource.data)) return bytesOrSource.data;
    const raw = bytesOrSource.data != null ? bytesOrSource.data : bytesOrSource.bytes;
    if (raw == null) throw new ArchiveError(CODES.ARCHIVE_ERROR, "Entry payload is missing.");
    const enc = bytesOrSource.encoding === "base64" ? "base64" : "utf8";
    return Buffer.from(String(raw), enc);
  }
  throw new ArchiveError(CODES.ARCHIVE_ERROR, "Entry payload is missing.");
}

function storeEntry(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : toBytes(bytes);
  const utf8 = buffer.toString("utf8");
  if (buffer.equals(Buffer.from(utf8, "utf8"))) {
    return { encoding: "utf8", data: utf8, size: buffer.length };
  }
  return { encoding: "base64", data: buffer.toString("base64"), size: buffer.length };
}

function entryBytes(stored) {
  if (stored == null) return Buffer.alloc(0);
  if (typeof stored === "string") return Buffer.from(stored, "utf8");
  const enc = stored.encoding === "base64" ? "base64" : "utf8";
  return Buffer.from(String(stored.data || ""), enc);
}

function entryHash(stored) {
  return hashBuffer(entryBytes(stored));
}

function canonicalEntries(archive) {
  const out = {};
  for (const key of Object.keys(archive.entries || {}).sort()) {
    out[key] = storeEntry(entryBytes(archive.entries[key]));
  }
  return out;
}

function serializeArchive(archive) {
  return `${JSON.stringify(
    {
      kind: KIND,
      name: archive.name,
      formatVersion: 1,
      entries: canonicalEntries(archive),
    },
    null,
    2
  )}\n`;
}

function computeArchiveHash(archive) {
  const rows = [`name\t${archive.name}`];
  for (const key of Object.keys(archive.entries || {}).sort()) {
    rows.push(`${key}\t${entryHash(archive.entries[key])}`);
  }
  return hashString(rows.join("\n"));
}

function archiveByteSize(archive) {
  return Buffer.byteLength(serializeArchive(archive), "utf8");
}

function resolveArchiveFile(archivePath) {
  rejectRealRpf(archivePath);
  const resolved = path.resolve(archivePath);
  rejectRealRpf(resolved);
  if (!fs.existsSync(resolved)) {
    throw new ArchiveError(CODES.ARCHIVE_ERROR, "Mock archive does not exist.", { file: resolved });
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return path.join(resolved, "archive.json");
  return resolved;
}

function loadArchiveObject(archivePath) {
  rejectRealRpf(archivePath);
  const file = resolveArchiveFile(archivePath);
  rejectRealRpf(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new ArchiveError(CODES.ARCHIVE_ERROR, "Mock archive could not be read as JSON.", { file });
  }
  if (!raw || raw.kind !== KIND || !raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) {
    throw new ArchiveError(CODES.ARCHIVE_ERROR, "Mock archive structure is invalid.", { file });
  }
  return {
    file,
    archive: {
      kind: KIND,
      name: raw.name || path.basename(archivePath, path.extname(archivePath)),
      formatVersion: 1,
      entries: { ...raw.entries },
    },
  };
}

function writeMockArchive(filePath, name, entries = {}) {
  rejectRealRpf(filePath);
  const archive = { kind: KIND, name: name || "mock.rpf", formatVersion: 1, entries: {} };
  for (const [key, value] of Object.entries(entries)) {
    archive.entries[normalizeEntryPath(key)] = storeEntry(toBytes(value));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serializeArchive(archive), "utf8");
  return filePath;
}

function assertOpen(handle) {
  if (!handle || handle.closed || !handles.has(handle.id)) {
    throw new ArchiveError(CODES.ARCHIVE_ERROR, "Archive handle is closed or invalid.");
  }
}

function assertWritable(handle) {
  assertOpen(handle);
  if (handle.readOnly) {
    throw new ArchiveError(CODES.ARCHIVE_ERROR, "Archive handle is read-only.");
  }
}

function openArchive(archivePath, options = {}) {
  rejectRealRpf(archivePath);
  const { file, archive } = loadArchiveObject(archivePath);
  const handle = {
    id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `mock-${Date.now()}`,
    backend: "mock",
    path: file,
    archiveRoot: path.resolve(archivePath),
    name: archive.name,
    archive,
    dirty: false,
    closed: false,
    readOnly: options.readOnly === true,
  };
  handles.set(handle.id, handle);
  return handle;
}

function listEntries(handle) {
  assertOpen(handle);
  return Object.keys(handle.archive.entries).sort();
}

function entryExists(handle, entryPath) {
  assertOpen(handle);
  return Object.prototype.hasOwnProperty.call(handle.archive.entries, normalizeEntryPath(entryPath));
}

function readEntry(handle, entryPath) {
  assertOpen(handle);
  const key = normalizeEntryPath(entryPath);
  if (!Object.prototype.hasOwnProperty.call(handle.archive.entries, key)) {
    throw new ArchiveError(CODES.ARCHIVE_ERROR, "Archive entry does not exist.", { file: key });
  }
  return Buffer.from(entryBytes(handle.archive.entries[key]));
}

function getEntryMetadata(handle, entryPath) {
  assertOpen(handle);
  const key = normalizeEntryPath(entryPath);
  if (!Object.prototype.hasOwnProperty.call(handle.archive.entries, key)) {
    return { path: key, exists: false, size: 0, hash: null };
  }
  const stored = handle.archive.entries[key];
  const bytes = entryBytes(stored);
  return { path: key, exists: true, size: bytes.length, hash: hashBuffer(bytes) };
}

function addEntry(handle, entryPath, bytesOrSource) {
  assertWritable(handle);
  const key = normalizeEntryPath(entryPath);
  if (Object.prototype.hasOwnProperty.call(handle.archive.entries, key)) {
    throw new ArchiveError(CODES.ARCHIVE_ERROR, "Archive entry already exists.", { file: key });
  }
  handle.archive.entries[key] = storeEntry(toBytes(bytesOrSource));
  handle.dirty = true;
  return getEntryMetadata(handle, key);
}

function replaceEntry(handle, entryPath, bytesOrSource) {
  assertWritable(handle);
  const key = normalizeEntryPath(entryPath);
  if (!Object.prototype.hasOwnProperty.call(handle.archive.entries, key)) {
    throw new ArchiveError(CODES.ARCHIVE_ERROR, "Archive entry does not exist.", { file: key });
  }
  handle.archive.entries[key] = storeEntry(toBytes(bytesOrSource));
  handle.dirty = true;
  return getEntryMetadata(handle, key);
}

function removeEntry(handle, entryPath) {
  assertWritable(handle);
  const key = normalizeEntryPath(entryPath);
  if (!Object.prototype.hasOwnProperty.call(handle.archive.entries, key)) {
    throw new ArchiveError(CODES.ARCHIVE_ERROR, "Archive entry does not exist.", { file: key });
  }
  delete handle.archive.entries[key];
  handle.dirty = true;
  return { path: key, exists: false };
}

function validate(handle) {
  assertOpen(handle);
  const archive = handle.archive;
  if (!archive || archive.kind !== KIND || !archive.name || !archive.entries || typeof archive.entries !== "object") {
    throw new ArchiveError(CODES.VALIDATION_FAILED, "Mock archive structure is invalid.");
  }
  for (const key of Object.keys(archive.entries)) {
    normalizeEntryPath(key);
    entryBytes(archive.entries[key]);
  }
  return { ok: true, hash: computeArchiveHash(archive), entryCount: Object.keys(archive.entries).length };
}

function commit(handle) {
  assertWritable(handle);
  rejectRealRpf(handle.path);
  const dest = handle.path;
  const tmp = `${dest}.tmp`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(tmp, serializeArchive(handle.archive), "utf8");
  fs.renameSync(tmp, dest);
  handle.dirty = false;
  return { ok: true, path: dest, hash: computeArchiveHash(handle.archive) };
}

function close(handle) {
  if (!handle) return;
  handle.closed = true;
  handles.delete(handle.id);
}

function hashOfHandle(handle) {
  assertOpen(handle);
  return computeArchiveHash(handle.archive);
}

function identityOfHandle(handle) {
  assertOpen(handle);
  return {
    name: handle.archive.name,
    path: handle.path,
    hash: computeArchiveHash(handle.archive),
    size: archiveByteSize(handle.archive),
  };
}

function snapshotEntries(handle) {
  assertOpen(handle);
  const out = {};
  for (const key of Object.keys(handle.archive.entries)) {
    out[key] = storeEntry(entryBytes(handle.archive.entries[key]));
  }
  return out;
}

function replaceArchiveState(handle, archive) {
  assertWritable(handle);
  handle.archive = {
    kind: KIND,
    name: archive.name,
    formatVersion: 1,
    entries: { ...(archive.entries || {}) },
  };
  handle.dirty = true;
}

module.exports = {
  KIND,
  capabilities,
  rejectRealRpf,
  normalizeEntryPath,
  toBytes,
  storeEntry,
  entryBytes,
  entryHash,
  serializeArchive,
  computeArchiveHash,
  archiveByteSize,
  writeMockArchive,
  loadArchiveObject,
  openArchive,
  listEntries,
  entryExists,
  readEntry,
  getEntryMetadata,
  addEntry,
  replaceEntry,
  removeEntry,
  validate,
  commit,
  close,
  hashOfHandle,
  identityOfHandle,
  snapshotEntries,
  replaceArchiveState,
};
