const path = require("path");

const SCHEMA_VERSION = 1;

function asFiles(value) {
  return Array.isArray(value) ? value : [];
}

function validateManifest(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, status: "MANIFEST_ERROR", warning: "Manifest is missing or not an object.", manifest: null };
  }
  const id = String(raw.id || "").trim();
  if (!id) {
    return { ok: false, status: "MANIFEST_ERROR", warning: "Manifest has no install id.", manifest: raw };
  }
  if (!Array.isArray(raw.files)) {
    return { ok: false, status: "MANIFEST_ERROR", warning: "Manifest file list is missing.", manifest: raw };
  }
  const schemaVersion = Number(raw.schemaVersion) || SCHEMA_VERSION;
  return {
    ok: true,
    status: "OK",
    warning: "",
    manifest: {
      ...raw,
      schemaVersion,
      id,
      files: asFiles(raw.files),
      archiveOperations: Array.isArray(raw.archiveOperations) ? raw.archiveOperations : [],
    },
  };
}

function normalizeListed(raw, fileName) {
  const checked = validateManifest(raw);
  if (!checked.ok) {
    return {
      id: (raw && raw.id) || path.basename(fileName || "unknown", ".json"),
      name: (raw && raw.name) || "Unreadable mod",
      enabled: false,
      files: [],
      manifestStatus: "MANIFEST_ERROR",
      cardHealth: "Broken",
      warning: checked.warning,
      raw,
    };
  }
  return { ...checked.manifest, manifestStatus: "OK" };
}

module.exports = { SCHEMA_VERSION, validateManifest, normalizeListed };
