const fs = require("fs");
const path = require("path");

// Loads src/config/protectedFiles.json and evaluates whether a planned
// destination touches a protected launch file. This generalizes the
// XInput/ASI-loader protection that keeps the working LSPDFR launch alive.
//
// Design for v1: protected / blocked / risky files are SKIPPED during a
// Smart Install (never overwritten), and surfaced in the preview. The safe
// files still install. This protects the working launch by default.

const DEFAULT_CONFIG = path.join(__dirname, "..", "config", "protectedFiles.json");

// Severity ordering shared with the conflict detector.
const SEVERITY = ["NONE", "SAFE_REPLACEMENT", "WARNING", "HIGH_RISK", "BLOCKED"];

function maxSeverity(a, b) {
  return SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b;
}

let cached = null;

function load(configPath = DEFAULT_CONFIG) {
  if (configPath === DEFAULT_CONFIG && cached) return cached;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    data = { protected: [], blockedIncoming: [], riskyIncoming: [] };
  }
  const normalized = {
    protected: Array.isArray(data.protected) ? data.protected : [],
    blockedIncoming: Array.isArray(data.blockedIncoming) ? data.blockedIncoming : [],
    riskyIncoming: Array.isArray(data.riskyIncoming) ? data.riskyIncoming : [],
  };
  if (configPath === DEFAULT_CONFIG) cached = normalized;
  return normalized;
}

function norm(rel) {
  return String(rel || "").replace(/\\/g, "/").toLowerCase();
}

function baseName(rel) {
  return path.basename(norm(rel));
}

function entryMatches(entry, destRel) {
  const target = norm(entry.match);
  if (entry.matchType === "path") return norm(destRel) === target;
  return baseName(destRel) === target;
}

function findProtected(destRel, config = load()) {
  return config.protected.find((entry) => entryMatches(entry, destRel)) || null;
}

function findBlockedIncoming(destRel, config = load()) {
  return config.blockedIncoming.find((entry) => entryMatches(entry, destRel)) || null;
}

function findRiskyIncoming(destRel, config = load()) {
  return config.riskyIncoming.find((entry) => entryMatches(entry, destRel)) || null;
}

// Full evaluation for a single planned copy.
// Returns { skip, severity, level, reason, kind } where kind describes why.
// existingSize / incomingSize are optional; when provided, a "noShrink"
// protected file (like XInput1_4.dll) that would shrink dramatically is
// flagged, matching the known ASI-loader failure mode.
function evaluate({ destRel, incomingSize = null, existingSize = null, config = load() }) {
  const blocked = findBlockedIncoming(destRel, config);
  if (blocked) {
    return {
      skip: true,
      severity: "HIGH_RISK",
      level: "critical",
      kind: "blocked-incoming",
      reason: blocked.note || "This file must never be installed.",
    };
  }

  const prot = findProtected(destRel, config);
  if (prot) {
    let severity = prot.level === "critical" ? "HIGH_RISK" : "WARNING";
    let reason = prot.note || "This is a protected launch file and will not be overwritten.";
    if (
      prot.noShrink &&
      typeof existingSize === "number" &&
      typeof incomingSize === "number" &&
      existingSize > 0 &&
      incomingSize > 0 &&
      incomingSize < existingSize * 0.5
    ) {
      severity = "HIGH_RISK";
      reason =
        `${prot.match} would be replaced by a much smaller file ` +
        `(${incomingSize} vs ${existingSize} bytes). ${reason}`;
    }
    return {
      skip: true,
      severity,
      level: prot.level || "warning",
      kind: "protected",
      owner: prot.owner || "protected",
      reason,
    };
  }

  const risky = findRiskyIncoming(destRel, config);
  if (risky) {
    return {
      skip: true,
      severity: "HIGH_RISK",
      level: "warning",
      kind: "risky-incoming",
      reason: risky.note || "This file can destabilize the RPH launch and will not be installed.",
    };
  }

  return { skip: false, severity: "NONE", level: "none", kind: "none", reason: "" };
}

module.exports = {
  DEFAULT_CONFIG,
  SEVERITY,
  maxSeverity,
  load,
  findProtected,
  findBlockedIncoming,
  findRiskyIncoming,
  evaluate,
};
