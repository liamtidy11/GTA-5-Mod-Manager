// Archive backend contract. The rest of the app talks to this interface,
// never to a specific RPF library. Mock writes stay on the mock backend.
// Real .rpf files use the Phase 3C read-only OPEN RPF7 backend.

const BACKEND_METHODS = [
  "openArchive",
  "listEntries",
  "entryExists",
  "readEntry",
  "getEntryMetadata",
  "addEntry",
  "replaceEntry",
  "removeEntry",
  "validate",
  "commit",
  "close",
];

const MOCK_CAPABILITIES = {
  read: true,
  write: true,
  add: true,
  replace: true,
  remove: true,
  transactional: true,
  realGtaArchives: false,
};

const REAL_READONLY_CAPABILITIES = {
  read: true,
  write: false,
  add: false,
  replace: false,
  remove: false,
  transactional: false,
  realGtaArchives: true,
};

function isRealRpfPath(archivePath) {
  const trimmed = String(archivePath || "")
    .trim()
    .replace(/[\\/]+$/, "");
  return /\.rpf$/i.test(trimmed);
}

function assertBackendContract(backend) {
  const missing = BACKEND_METHODS.filter((name) => typeof backend[name] !== "function");
  if (missing.length) {
    throw new Error(`Archive backend is missing: ${missing.join(", ")}`);
  }
  return true;
}

module.exports = {
  BACKEND_METHODS,
  MOCK_CAPABILITIES,
  REAL_READONLY_CAPABILITIES,
  isRealRpfPath,
  assertBackendContract,
};
