// One overall Duty health status plus a compact, actionable alert list.
// Health is HEALTHY / WARNING / BROKEN — no fake percentage precision.

const STATUS = { HEALTHY: "HEALTHY", WARNING: "WARNING", BROKEN: "BROKEN" };

// Priority order for the dashboard. Lower number = more urgent.
const PRIORITY = {
  LAUNCH_BLOCKING: 1,
  BROKEN_MOD: 2,
  MISSING_REQUIRED_DEPENDENCY: 3,
  PROFILE_DRIFT: 4,
  STALE_CRASH_ANALYSIS: 5,
  UNKNOWN_COMPATIBILITY: 6,
  INFORMATIONAL: 7,
};

function summarize({ tests = null, modHealth = [], profile = null, overlays = null, missingRequiredDeps = [] } = {}) {
  const reasons = [];
  let status = STATUS.HEALTHY;

  const brokenMods = modHealth.filter((m) => m.status === "BROKEN");
  const warningMods = modHealth.filter((m) => m.status === "WARNING");

  if ((tests && tests.blocking > 0) || brokenMods.length || missingRequiredDeps.length) {
    status = STATUS.BROKEN;
  }

  if (tests && tests.blocking > 0) reasons.push(`${tests.blocking} launch-blocking issue(s) detected.`);
  for (const mod of brokenMods.slice(0, 3)) reasons.push(`${mod.installId ? "" : ""}${(mod.reasons || [])[0] || "A mod is broken."}`);
  for (const dep of missingRequiredDeps.slice(0, 3)) reasons.push(`Required dependency missing: ${dep.name || dep.componentId || dep}.`);

  const drifted = profile && profile.drift && profile.drift.drifted;
  const overlayOn = overlays && (overlays.nvidiaOverlay || overlays.nvidiaShare);

  if (status !== STATUS.BROKEN) {
    if ((tests && tests.warnings > 0) || warningMods.length || drifted || overlayOn) {
      status = STATUS.WARNING;
    }
    if (tests && tests.warnings > 0) reasons.push(`${tests.warnings} warning(s) from the function test.`);
    if (warningMods.length) reasons.push(`${warningMods.length} mod(s) need attention.`);
    if (drifted) {
      const note = (profile.drift.notes || [])[0];
      reasons.push(profile.profile ? `${profile.profile.name} differs from the current Duty setup.` : "Active profile differs from current state.");
      if (note) reasons.push(note);
    }
    if (overlayOn) reasons.push("An overlay (NVIDIA) is running and can destabilize the hook.");
  }

  return { status, reasons: reasons.filter(Boolean).slice(0, 6) };
}

function priorityAlerts({
  tests = null,
  modHealth = [],
  profile = null,
  missingRequiredDeps = [],
  staleAnalysisCount = 0,
} = {}) {
  const alerts = [];

  for (const check of (tests && tests.checks) || []) {
    if (!check.ok && check.level === "bad") {
      alerts.push({ priority: PRIORITY.LAUNCH_BLOCKING, kind: "LAUNCH_BLOCKING", title: check.title, detail: check.detail });
    }
  }

  for (const mod of modHealth) {
    if (mod.status === "BROKEN") {
      alerts.push({ priority: PRIORITY.BROKEN_MOD, kind: "BROKEN_MOD", title: "Broken mod", detail: (mod.reasons || [])[0] || "A managed mod is broken.", installId: mod.installId });
    }
  }

  for (const dep of missingRequiredDeps) {
    alerts.push({
      priority: PRIORITY.MISSING_REQUIRED_DEPENDENCY,
      kind: "MISSING_REQUIRED_DEPENDENCY",
      title: "Missing required dependency",
      detail: `${dep.name || dep.componentId || dep} is required but not installed.`,
    });
  }

  if (profile && profile.drift && profile.drift.drifted) {
    alerts.push({
      priority: PRIORITY.PROFILE_DRIFT,
      kind: "PROFILE_DRIFT",
      title: "Profile drift",
      detail: profile.profile ? `${profile.profile.name} differs from the current Duty setup.` : "Active profile differs from current state.",
    });
  }

  if (staleAnalysisCount > 0) {
    alerts.push({
      priority: PRIORITY.STALE_CRASH_ANALYSIS,
      kind: "STALE_CRASH_ANALYSIS",
      title: "Stale crash analysis",
      detail: `${staleAnalysisCount} crash analysis result(s) are out of date. Re-analyze before testing.`,
    });
  }

  for (const mod of modHealth) {
    if (mod.status === "WARNING" && (mod.reasons || []).some((r) => /compatibility.*unknown/i.test(r))) {
      alerts.push({
        priority: PRIORITY.UNKNOWN_COMPATIBILITY,
        kind: "UNKNOWN_COMPATIBILITY",
        title: "Unknown compatibility",
        detail: (mod.reasons || []).find((r) => /compatibility/i.test(r)) || "Compatibility is unknown.",
        installId: mod.installId,
      });
    }
  }

  return alerts.sort((a, b) => a.priority - b.priority);
}

function startupSummary({ dutyFound = false, profile = null, tests = null, modCount = 0, lastSession = null } = {}) {
  const launchIntegrityOk = Boolean(tests && tests.blocking === 0);
  const warnings = tests ? tests.warnings : 0;
  return {
    dutyFound,
    activeProfile: profile && profile.profile ? profile.profile.name : null,
    launchIntegrityOk,
    modCount,
    warnings,
    lastSession: lastSession ? { result: lastSession.result, durationMs: lastSession.durationMs } : null,
  };
}

module.exports = { STATUS, PRIORITY, summarize, priorityAlerts, startupSummary };
