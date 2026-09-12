const fs = require("fs");
const { createHash } = require("crypto");
const { analyzeLogText } = require("./logPatternAnalyzer");

function collectLogText(session) {
  if (session.logText) return String(session.logText);
  const parts = [];
  for (const row of session.copiedLogs || []) {
    if (row.content) {
      parts.push(String(row.content));
      continue;
    }
    if (row.copiedPath && fs.existsSync(row.copiedPath)) {
      try {
        parts.push(fs.readFileSync(row.copiedPath, "utf8"));
      } catch {
        /* session copy only; never reopen Duty logs */
      }
    }
  }
  return parts.join("\n");
}

function changeAction(row) {
  const raw = String((row && (row.action || row.event)) || "");
  if (raw === "INSTALL_COMMITTED") return "INSTALLED";
  return raw;
}

function evidenceFingerprint(session) {
  const payload = {
    result: session.result,
    endedAt: session.endedAt || "",
    logs: (session.logs || []).map((row) => row.hash || row.size || ""),
    copied: (session.copiedLogs || []).map((row) => row.hash || ""),
    mods: (session.mods || []).map((mod) => [mod.installId, mod.version || "", mod.enabled !== false ? 1 : 0]),
    env: session.environment
      ? [session.environment.gtaVersion, session.environment.rphVersion, session.environment.lspdfrVersion]
      : [],
    logText: session.logText ? hash(session.logText) : "",
  };
  return hash(JSON.stringify(payload));
}

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function buildEvidence(session, comparison) {
  const logText = collectLogText(session);
  const logs = analyzeLogText(logText);
  const recentChanges = (session.recentChanges || [])
    .map((row) => ({ ...row, action: changeAction(row) }))
    .filter((row) => /INSTALLED|UPDATED|DOWNGRADED|REPAIRED|ENABLED|DISABLED/.test(row.action));
  return {
    sessionId: session.sessionId,
    result: session.result,
    logText,
    logs,
    recentChanges,
    comparison,
    fingerprint: evidenceFingerprint(session),
    durationMs: session.durationMs || 0,
  };
}

function recentChangeFor(installId, recentChanges) {
  return (recentChanges || []).find((row) => row.installId === installId);
}

module.exports = { collectLogText, evidenceFingerprint, buildEvidence, recentChangeFor, hash, changeAction };
