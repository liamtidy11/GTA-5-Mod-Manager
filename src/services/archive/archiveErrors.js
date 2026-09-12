// Archive-layer errors. Codes are stable strings used by tests and callers.

const CODES = {
  REAL_ARCHIVE_BACKEND_NOT_AVAILABLE: "REAL_ARCHIVE_BACKEND_NOT_AVAILABLE",
  NATIVE_RPF_WRITES_NOT_ENABLED: "NATIVE_RPF_WRITES_NOT_ENABLED",
  STATE_CHANGED: "STATE_CHANGED",
  EXTERNALLY_MODIFIED: "EXTERNALLY_MODIFIED",
  ARCHIVE_ERROR: "ARCHIVE_ERROR",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INTERRUPTED: "INTERRUPTED",
  RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
  INVALID_RPF: "INVALID_RPF",
  UNSUPPORTED_RPF_VERSION: "UNSUPPORTED_RPF_VERSION",
  ENCRYPTED_RPF_NOT_SUPPORTED: "ENCRYPTED_RPF_NOT_SUPPORTED",
  ARCHIVE_READ_ERROR: "ARCHIVE_READ_ERROR",
};

class ArchiveError extends Error {
  constructor(code, message, extras = {}) {
    super(message);
    this.name = "ArchiveError";
    this.code = CODES[code] ? code : CODES.ARCHIVE_ERROR;
    this.category = this.code === CODES.STATE_CHANGED ? "STATE_CHANGED" : "ARCHIVE_ERROR";
    this.userMessage = message;
    this.file = extras.file || "";
    this.details = extras.details || "";
    this.whatToDo = extras.whatToDo || "";
  }
}

function fail(code, message, extras) {
  throw new ArchiveError(code, message, extras);
}

module.exports = { CODES, ArchiveError, fail };
