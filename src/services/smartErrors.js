// User-facing Smart Install errors. Stack traces stay in logs only.

const CATEGORIES = [
  "PACKAGE_ERROR",
  "SECURITY_ERROR",
  "ANALYSIS_ERROR",
  "DESTINATION_ERROR",
  "DEPENDENCY_ERROR",
  "COMPATIBILITY_WARNING",
  "TRANSACTION_ERROR",
  "ROLLBACK_ERROR",
  "STATE_CHANGED",
  "ARCHIVE_ERROR",
];

class SmartInstallError extends Error {
  constructor(category, message, extras = {}) {
    super(message);
    this.name = "SmartInstallError";
    this.category = CATEGORIES.includes(category) ? category : "ANALYSIS_ERROR";
    this.userMessage = message;
    this.whatToDo = extras.whatToDo || "";
    this.file = extras.file || "";
    this.details = extras.details || "";
  }

  formatUser() {
    const lines = ["INSTALLATION FAILED", "", this.userMessage];
    if (this.file) lines.push("", `The file:`, this.file);
    if (this.whatToDo) lines.push("", "What to do:", this.whatToDo);
    return lines.join("\n");
  }
}

function wrap(category, error, extras = {}) {
  if (error instanceof SmartInstallError) return error;
  return new SmartInstallError(category, error && error.message ? error.message : String(error), extras);
}

module.exports = { CATEGORIES, SmartInstallError, wrap };
