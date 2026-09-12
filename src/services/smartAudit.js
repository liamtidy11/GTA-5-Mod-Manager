const fs = require("fs");
const path = require("path");

// Local-only Smart Install audit, history helpers, and readiness metrics.
// Never sends data anywhere.

const EVENTS = [
  "ANALYZED",
  "INSTALL_STARTED",
  "INSTALL_COMMITTED",
  "INSTALL_FAILED",
  "ROLLBACK_STARTED",
  "ROLLBACK_COMPLETED",
  "ENABLED",
  "DISABLED",
  "UPDATED",
  "DOWNGRADED",
  "REPAIRED",
  "REMOVED",
  "ARCHIVE_PLAN_CREATED",
  "ARCHIVE_BACKUP_CREATED",
  "ARCHIVE_APPLY_STARTED",
  "ARCHIVE_ENTRY_ADDED",
  "ARCHIVE_ENTRY_REPLACED",
  "ARCHIVE_ENTRY_REMOVED",
  "ARCHIVE_VALIDATED",
  "ARCHIVE_COMMITTED",
  "ARCHIVE_ROLLBACK_STARTED",
  "ARCHIVE_ROLLBACK_COMPLETED",
  "ARCHIVE_RECOVERY_REQUIRED",
  "CRASH_ACTION_PLANNED",
  "CRASH_ACTION_APPLIED",
  "CRASH_RETEST_LAUNCHED",
  "CRASH_RETEST_COMPLETED",
  "CRASH_ACTION_RESTORED",
  "CRASH_ACTION_FAILED",
  "PROFILE_CREATED",
  "PROFILE_UPDATED",
  "PROFILE_SWITCH_STARTED",
  "PROFILE_SWITCH_COMPLETED",
  "PROFILE_SWITCH_ROLLED_BACK",
  "PROFILE_MARKED_KNOWN_GOOD",
  "SNAPSHOT_CREATED",
  "SNAPSHOT_RESTORE_STARTED",
  "SNAPSHOT_RESTORED",
  "SNAPSHOT_RESTORE_ROLLED_BACK",
  "SNAPSHOT_PINNED",
  "SNAPSHOT_DELETED",
];

function auditPath(dataDir) {
  return path.join(dataDir, "smart-audit.jsonl");
}

function metricsPath(dataDir) {
  return path.join(dataDir, "smart-metrics.json");
}

function now() {
  return new Date().toISOString();
}

function appendAudit(dataDir, event, extra = {}) {
  if (!dataDir || !EVENTS.includes(event)) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const row = {
      event,
      at: now(),
      installId: extra.installId || "",
      canonicalModId: extra.canonicalModId || null,
      analysisId: extra.analysisId || "",
      ...extra,
    };
    fs.appendFileSync(auditPath(dataDir), `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    /* audit must never break install */
  }
}

function readAudit(dataDir, limit = 50) {
  try {
    const lines = fs.readFileSync(auditPath(dataDir), "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function emptyMetrics() {
  return {
    successfulInstalls: 0,
    rollbackFailures: 0,
    blockedPackages: 0,
    analysisErrors: 0,
  };
}

function readMetrics(dataDir) {
  try {
    return { ...emptyMetrics(), ...JSON.parse(fs.readFileSync(metricsPath(dataDir), "utf8")) };
  } catch {
    return emptyMetrics();
  }
}

function bumpMetric(dataDir, key) {
  if (!dataDir) return emptyMetrics();
  const current = readMetrics(dataDir);
  if (Object.prototype.hasOwnProperty.call(current, key)) current[key] += 1;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(metricsPath(dataDir), JSON.stringify(current, null, 2), "utf8");
  } catch {
    /* ignore */
  }
  return current;
}

function pushHistory(manifest, event, note = "") {
  const history = Array.isArray(manifest.history) ? manifest.history.slice() : [];
  history.push({ event, at: now(), note });
  return history;
}

function historyLabel(entry) {
  const when = entry.at ? new Date(entry.at).toLocaleDateString() : "";
  const map = {
    INSTALLED: "Installed",
    UPDATED: "Updated",
    DOWNGRADED: "Downgraded",
    DISABLED: "Disabled",
    ENABLED: "Enabled",
    REPAIRED: "Repaired",
    REINSTALLED: "Reinstalled",
    REMOVED: "Removed",
  };
  return `${map[entry.event] || entry.event} ${when}`.trim();
}

module.exports = {
  EVENTS,
  appendAudit,
  readAudit,
  readMetrics,
  bumpMetric,
  pushHistory,
  historyLabel,
};
