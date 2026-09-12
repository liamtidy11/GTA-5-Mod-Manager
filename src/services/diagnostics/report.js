const fs = require("fs");
const path = require("path");
const { redactDeep, redact } = require("./redact");

// Builds a personal diagnostic report. Never includes credentials or unrelated
// files. All strings are redacted for user/home/secret leakage.

function boundedExcerpt(text, maxLines = 60) {
  return String(text || "")
    .split(/\r?\n/)
    .slice(-maxLines)
    .join("\n");
}

function buildReport(context = {}, redactOptions = {}) {
  const report = {
    generatedAt: new Date().toISOString(),
    appVersion: context.appVersion || "0.0.0",
    appHealth: context.appHealth || null,
    dutyHealth: context.dutyHealth || null,
    activeProfile: context.activeProfile
      ? {
          name: context.activeProfile.name,
          knownGood: Boolean(context.activeProfile.knownGood),
          drifted: Boolean(context.activeProfile.drifted),
        }
      : null,
    environment: context.environment || null,
    mods: (context.mods || []).map((mod) => ({
      name: mod.name,
      version: mod.version || "UNKNOWN",
      enabled: mod.enabled !== false,
      health: mod.health || mod.cardHealth || "UNKNOWN",
      compatibility: mod.compatibilityStatus || mod.compatibility || "UNKNOWN",
    })),
    dependencies: context.dependencies || null,
    lastSession: context.lastSession
      ? {
          result: context.lastSession.result,
          durationMs: context.lastSession.durationMs,
          startedAt: context.lastSession.startedAt,
        }
      : null,
    crashAnalysis: context.crashAnalysis
      ? {
          result: context.crashAnalysis.result,
          analysisConfidence: context.crashAnalysis.analysisConfidence,
          topSuspect: (context.crashAnalysis.suspects || [])[0]
            ? { name: context.crashAnalysis.suspects[0].name, confidence: context.crashAnalysis.suspects[0].confidence }
            : null,
        }
      : null,
    launchInvariants: context.launchInvariants || null,
    logs: (context.logs || []).map((log) => ({
      name: log.name,
      excerpt: boundedExcerpt(log.excerpt || (log.errors || []).join("\n")),
    })),
  };

  return redactDeep(report, redactOptions);
}

// Writes the report to a folder (no external zip dependency required).
function writeReport(destDir, report, redactOptions = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const logsDir = path.join(destDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  for (const log of report.logs || []) {
    const safeName = String(log.name || "log").replace(/[^A-Za-z0-9._-]/g, "_");
    fs.writeFileSync(path.join(logsDir, `${safeName}.txt`), redact(log.excerpt || "", redactOptions), "utf8");
  }
  return destDir;
}

module.exports = { buildReport, writeReport, boundedExcerpt };
