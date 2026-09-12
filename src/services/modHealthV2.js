// One unified health model for every managed mod. Never shows a bare
// "Warning" — every non-healthy state carries plain-language reasons.
// Crash correlation is observational only; it never claims a mod caused a crash.

const STATES = {
  HEALTHY: "HEALTHY",
  WARNING: "WARNING",
  BROKEN: "BROKEN",
  DISABLED: "DISABLED",
  UNKNOWN: "UNKNOWN",
};

const FAILED_RESULTS = new Set(["GAME_CRASH", "RPH_CRASH", "LSPDFR_CRASH"]);

function modWasEnabled(session, installId) {
  return (session.mods || []).some((mod) => (mod.installId === installId || mod.id === installId) && mod.enabled !== false);
}

// Compact crash correlation for a mod card. Observational, not causal.
function crashCorrelation(installId, sessions = []) {
  let clean = 0;
  let failed = 0;
  for (const session of sessions || []) {
    if (!modWasEnabled(session, installId)) continue;
    if (session.result === "CLEAN_EXIT") clean += 1;
    else if (FAILED_RESULTS.has(session.result)) failed += 1;
  }
  const total = clean + failed;
  let level = "NONE";
  if (failed > 0) {
    const ratio = failed / total;
    if (failed >= 3 && ratio >= 0.5) level = "HIGH";
    else if (failed >= 2 || ratio >= 0.34) level = "MEDIUM";
    else level = "LOW";
  }
  return { clean, failed, total, level };
}

function profilesUsing(installId, profiles = []) {
  return (profiles || [])
    .filter((profile) => (profile.mods || []).some((mod) => mod.installId === installId))
    .map((profile) => profile.name);
}

// mod: a Smart Install list() row. context supplies live evidence.
function evaluateModHealth(mod = {}, context = {}) {
  const installId = mod.id || mod.installId;
  const reasons = [];
  const crash = crashCorrelation(installId, context.sessions || []);
  const profiles = profilesUsing(installId, context.profiles || []);

  if (mod.enabled === false) {
    return {
      installId,
      status: STATES.DISABLED,
      reasons: ["This mod is disabled. Its files are parked and not loaded."],
      crash,
      profiles,
    };
  }

  const diagnosis = context.diagnosis || null;
  const manifestBroken = mod.manifestStatus === "MANIFEST_ERROR" || (diagnosis && diagnosis.status === "BROKEN");

  if (manifestBroken) {
    if (mod.manifestStatus === "MANIFEST_ERROR") reasons.push("The manifest for this mod is unreadable.");
    for (const issue of (diagnosis && diagnosis.issues) || []) {
      if (issue.code === "MISSING_MANAGED_FILE" || issue.code === "MANIFEST_ERROR") reasons.push(issue.message);
    }
    if (!reasons.length) reasons.push("Managed files are missing.");
    return { installId, status: STATES.BROKEN, reasons, crash, profiles };
  }

  // Non-fatal issues accumulate into WARNING with explicit reasons.
  for (const issue of (diagnosis && diagnosis.issues) || []) {
    if (issue.code === "FILE_CHANGED_OUTSIDE") reasons.push(issue.message);
    else if (issue.code === "BACKUP_MISSING") reasons.push(issue.message);
    else if (issue.code === "STORE_MISSING") reasons.push(issue.message);
  }

  const depSummary = mod.dependencySummary || {};
  if (depSummary.hasBlockingDependencyIssue) {
    reasons.push("A required dependency is missing, disabled, or too old.");
  }

  const runtime = context.runtime || null;
  const runtimeWorked = runtime && runtime.status === "WORKED";
  const runtimeFailed = runtime && runtime.status === "FAILED";

  const compat = String(mod.compatibilityStatus || mod.compatibility || "UNKNOWN").toUpperCase();
  if (compat === "INCOMPATIBLE") {
    reasons.push("Trusted data records this mod as incompatible with GTA V Enhanced.");
    return { installId, status: STATES.BROKEN, reasons, crash, profiles, runtime };
  }
  if (compat === "WARNING") reasons.push("A compatibility warning applies to this mod.");
  else if (compat === "UNKNOWN" && !runtimeWorked && !runtimeFailed) {
    reasons.push("Compatibility with this Duty setup is unknown.");
  }

  if (runtimeFailed) {
    reasons.push(runtime.evidence || "The last Duty session showed this plugin failed to stay loaded.");
  }

  if (crash.level === "HIGH" || crash.level === "MEDIUM") {
    reasons.push(`${crash.failed} failed and ${crash.clean} clean sessions ran with this mod enabled (correlation, not proof).`);
  }

  let status = STATES.HEALTHY;
  if (depSummary.hasBlockingDependencyIssue) status = STATES.BROKEN;
  else if (reasons.length) status = STATES.WARNING;

  if (status === STATES.HEALTHY) {
    if (runtimeWorked) {
      reasons.push(
        runtime.kind === "SESSION_PRESENT"
          ? runtime.evidence || "This install was enabled during a clean Duty session."
          : runtime.evidence || "This install loaded in a local Duty session."
      );
    } else {
      reasons.push("Manifest valid, files present, no blocking issues.");
    }
  }

  return { installId, status, reasons, crash, profiles, runtime };
}

function summarizeCounts(healthList = []) {
  const counts = { HEALTHY: 0, WARNING: 0, BROKEN: 0, DISABLED: 0, UNKNOWN: 0 };
  for (const row of healthList) {
    counts[row.status] = (counts[row.status] || 0) + 1;
  }
  return counts;
}

module.exports = {
  STATES,
  crashCorrelation,
  profilesUsing,
  evaluateModHealth,
  summarizeCounts,
};
