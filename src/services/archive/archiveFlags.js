// Native GTA archive writes stay off. This constant is the production gate.
// Tests may pass { allowMockWrites: true } for mock archives only.
// process.env is never consulted to enable real RPF writes.

const ENABLE_NATIVE_ARCHIVE_WRITES = false;

function nativeArchiveWritesEnabled() {
  return ENABLE_NATIVE_ARCHIVE_WRITES === true;
}

function mockWritesAllowed(options = {}) {
  return options.allowMockWrites === true;
}

module.exports = {
  ENABLE_NATIVE_ARCHIVE_WRITES,
  nativeArchiveWritesEnabled,
  mockWritesAllowed,
};
