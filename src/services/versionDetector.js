const path = require("path");
const fileVersionReader = require("./fileVersionReader");

const UNKNOWN = "UNKNOWN";

// Version intelligence: normalize, compare, and detect. Never guesses.
// File metadata is preferred over manifests. Detection never executes binaries.

function unknownResult(reason = "NONE") {
  return {
    version: UNKNOWN,
    versionSource: "NONE",
    versionConfidence: "UNKNOWN",
    reason,
  };
}

function stripV(text) {
  return String(text || "").trim().replace(/^[vV]/, "");
}

function normalizeVersion(value) {
  if (value == null || value === "" || value === UNKNOWN) {
    return { raw: value == null ? "" : String(value), canonical: UNKNOWN, parts: [], prerelease: "", build: "", unknown: true };
  }
  const raw = String(value).trim();
  let text = stripV(raw);
  let build = "";
  let prerelease = "";
  const plus = text.indexOf("+");
  if (plus >= 0) {
    build = text.slice(plus + 1);
    text = text.slice(0, plus);
  }
  const dash = text.indexOf("-");
  if (dash >= 0) {
    prerelease = text.slice(dash + 1);
    text = text.slice(0, dash);
  }
  if (!/^\d+(\.\d+){0,5}$/.test(text)) {
    return { raw, canonical: UNKNOWN, parts: [], prerelease: "", build: "", unknown: true };
  }
  const parts = text.split(".").map((n) => Number(n));
  if (parts.some((n) => !Number.isFinite(n))) {
    return { raw, canonical: UNKNOWN, parts: [], prerelease: "", build: "", unknown: true };
  }
  const trimmed = [...parts];
  while (trimmed.length > 3 && trimmed[trimmed.length - 1] === 0) trimmed.pop();
  const canonical = `${trimmed.join(".")}${prerelease ? `-${prerelease}` : ""}`;
  return { raw, canonical, parts, prerelease, build, unknown: false };
}

function comparePrerelease(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= as.length) return -1;
    if (i >= bs.length) return 1;
    const an = /^\d+$/.test(as[i]);
    const bn = /^\d+$/.test(bs[i]);
    if (an && bn) {
      const d = Number(as[i]) - Number(bs[i]);
      if (d) return d < 0 ? -1 : 1;
    } else if (an && !bn) return -1;
    else if (!an && bn) return 1;
    else if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1;
  }
  return 0;
}

function compareVersions(a, b) {
  const left = typeof a === "object" && a && "parts" in a ? a : normalizeVersion(a);
  const right = typeof b === "object" && b && "parts" in b ? b : normalizeVersion(b);
  if (left.unknown || right.unknown) return null;
  const n = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < n; i += 1) {
    const lv = left.parts[i] || 0;
    const rv = right.parts[i] || 0;
    if (lv < rv) return -1;
    if (lv > rv) return 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function parseRequirement(requirement) {
  const text = String(requirement || "").trim();
  const match = text.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!match) return null;
  const operator = match[1] || "=";
  const version = normalizeVersion(match[2]);
  if (version.unknown) return null;
  return { operator, version, raw: text };
}

function satisfiesVersion(installed, requirement) {
  const req = parseRequirement(requirement);
  if (!req) {
    return { status: "INVALID_REQUIREMENT", installed: installed || UNKNOWN, requirement: String(requirement || "") };
  }
  const have = normalizeVersion(installed);
  if (have.unknown) {
    return { status: "UNKNOWN", installed: UNKNOWN, requirement: req.raw };
  }
  const cmp = compareVersions(have, req.version);
  if (cmp == null) {
    return { status: "UNKNOWN", installed: have.canonical, requirement: req.raw };
  }
  let ok = false;
  if (req.operator === ">=") ok = cmp >= 0;
  else if (req.operator === ">") ok = cmp > 0;
  else if (req.operator === "<=") ok = cmp <= 0;
  else if (req.operator === "<") ok = cmp < 0;
  else ok = cmp === 0;

  let status = "SATISFIED";
  if (!ok) status = cmp < 0 ? "TOO_OLD" : "TOO_NEW";
  return { status, installed: have.canonical, requirement: req.raw };
}

function pickBestString(meta) {
  const candidates = [meta && meta.productVersion, meta && meta.fileVersion].filter(Boolean);
  for (const value of candidates) {
    const norm = normalizeVersion(value);
    if (!norm.unknown) return { version: norm.canonical, raw: value };
  }
  return null;
}

function detectFileVersion(filePath, reader = fileVersionReader.readFileVersion) {
  if (!filePath) return unknownResult("MISSING");
  let meta;
  try {
    meta = reader(filePath);
  } catch {
    return unknownResult("MALFORMED_PE");
  }
  if (!meta) return unknownResult("NONE");
  if (meta.reason && ["MISSING", "ACCESS_DENIED", "LOCKED", "NOT_PE", "MALFORMED_PE"].includes(meta.reason)) {
    return unknownResult(meta.reason);
  }
  const picked = pickBestString(meta);
  if (!picked) return unknownResult(meta.reason || "NO_VERSION");
  return {
    version: picked.version,
    versionSource: "FILE_METADATA",
    versionConfidence: "HIGH",
    reason: "OK",
    productName: meta.productName || null,
    companyName: meta.companyName || null,
    raw: picked.raw,
  };
}

function detectComponentVersion(component, context = {}) {
  const reader = context.readFileVersion || fileVersionReader.readFileVersion;
  const files = [];
  if (component && component.liveAbs) files.push(component.liveAbs);
  for (const abs of component && component.parkedAbs ? component.parkedAbs : []) {
    if (abs) files.push(abs);
  }

  for (const file of files) {
    const detected = detectFileVersion(file, reader);
    if (detected.version !== UNKNOWN) return detected;
  }

  const manifestVersion = context.manifestVersion;
  if (manifestVersion) {
    const norm = normalizeVersion(manifestVersion);
    if (!norm.unknown) {
      return {
        version: norm.canonical,
        versionSource: "MANIFEST",
        versionConfidence: "HIGH",
        reason: "MANIFEST",
      };
    }
  }

  return unknownResult(files.length ? "NO_VERSION" : "MISSING");
}

function applyVersion(target, detected) {
  target.version = detected.version || UNKNOWN;
  target.versionSource = detected.versionSource || "NONE";
  target.versionConfidence = detected.versionConfidence || "UNKNOWN";
  return target;
}

function resolveParkedAbs(dutyPath, dataDir, rel, source) {
  if (!rel) return "";
  if (source === "MANIFEST" && dataDir) return path.join(dataDir, "disabled", rel.split("/").join(path.sep));
  if (!dutyPath) return "";
  return path.join(dutyPath, ".tactix", "disabled", rel.split("/").join(path.sep));
}

module.exports = {
  UNKNOWN,
  normalizeVersion,
  compareVersions,
  satisfiesVersion,
  detectFileVersion,
  detectComponentVersion,
  applyVersion,
  resolveParkedAbs,
  unknownResult,
};
