const { ACTION_TYPES, ACTION_STATES, RETEST_OUTCOMES } = require("./crashActionTypes");

const STALE_COPY =
  "This crash analysis is out of date because the Duty setup changed.\n\nRe-analyze before applying a test.";

function actionAvailable(plan, analysis) {
  if (!plan || plan.type === ACTION_TYPES.NO_SAFE_ACTION) return false;
  if (plan.available === false) return false;
  if (analysis && (analysis.stale || analysis.status === "STALE")) return false;
  return true;
}

function confirmationCopy(plan) {
  const name = plan.targetName || "this component";
  if (plan.type === ACTION_TYPES.DISABLE_MOD_AND_RETEST) {
    return {
      title: "Test this theory?",
      body: `${name} will be disabled temporarily.\n\nNo files will be deleted.\nYour current state can be restored after the test.`,
      confirm: "Disable & Retest",
      extra: "",
    };
  }
  if (plan.type === ACTION_TYPES.ROLLBACK_MOD_AND_RETEST) {
    const preview = plan.preview || {};
    return {
      title: "Restore previous version?",
      body: `Current version:\n${preview.from || "unknown"}\n\nRestore:\n${preview.to || "unknown"}\n\nConfigs:\n${preview.configPolicy || "Keep existing"}\n\nFiles:\n${preview.filesReplaced || 0} replaced\n${preview.filesRestored || 0} restored`,
      confirm: "Restore Previous Version",
      extra: "",
    };
  }
  if (plan.type === ACTION_TYPES.REPAIR_MOD_AND_RETEST || plan.type === ACTION_TYPES.REPAIR_EXISTING_DEPENDENCY) {
    return {
      title: "Repair and retest?",
      body: `Repair will restore missing managed files for ${name}. Compatibility problems are not repaired this way.`,
      confirm: "Repair & Retest",
      extra: "",
    };
  }
  if (plan.type === ACTION_TYPES.CLOSE_OVERLAY_AND_RETEST) {
    return {
      title: "Close overlay and retest?",
      body: "NVIDIA Overlay will be closed for this launch using the existing temporary suppression. Driver settings are not changed.",
      confirm: "Close Overlay & Retest",
      extra: "",
    };
  }
  if (plan.type === ACTION_TYPES.RE_ENABLE_MOD) {
    return {
      title: "Re-enable dependency?",
      body: "Required dependency is disabled.\n\nRe-enabling it may reintroduce a known local stability issue.",
      confirm: "Re-enable & Retest",
      extra: "strong",
    };
  }
  if (plan.type === ACTION_TYPES.MINIMAL_RETEST) {
    return {
      title: "Minimal retest?",
      body: "Recently changed managed mods will be disabled. The core known-good stack stays in place.",
      confirm: "Minimal Retest",
      extra: "",
    };
  }
  return {
    title: "Apply test?",
    body: plan.changes ? plan.changes.join("\n") : "Apply this crash test.",
    confirm: "Continue",
    extra: "",
  };
}

function pendingBanner(action, originalSession) {
  if (!action) return "";
  const when = originalSession && originalSession.startedAt ? originalSession.startedAt : action.sessionId;
  return {
    title: "Retest mode",
    testing: (action.changes && action.changes[0]) || action.targetName || action.type,
    original: when,
    state: action.state,
    launchFailed: action.retest && action.retest.outcome === RETEST_OUTCOMES.LAUNCH_FAILED,
  };
}

function retestResultCopy(action, originalSession = {}, retestSession = {}) {
  const outcome = (action.retest && action.retest.outcome) || RETEST_OUTCOMES.UNKNOWN;
  const originalMs = originalSession.durationMs || (action.snapshot && action.snapshot.originalDurationMs) || 0;
  const retestMs = retestSession.durationMs || (action.retest && action.retest.durationMs) || 0;
  if (outcome === RETEST_OUTCOMES.CRASH_REPRODUCED) {
    return {
      title: "Crash reproduced",
      body: `The same crash occurred with ${action.targetName || "the tested change"} applied.\n\nThis weakens ${action.targetName || "that change"} as the primary suspect.`,
      keepLabel: "",
      restoreLabel: "Restore previous state",
    };
  }
  if (outcome === RETEST_OUTCOMES.LAUNCH_FAILED) {
    return {
      title: "Launch failed",
      body: "Test change was applied, but LSPDFR did not launch.",
      keepLabel: "",
      restoreLabel: "Restore previous state",
    };
  }
  if (outcome === RETEST_OUTCOMES.NO_CRASH_OBSERVED) {
    return {
      title: "Retest complete",
      body: `Original session:\nCrashed after ${formatDuration(originalMs)}\n\nRetest:\nRan ${formatDuration(retestMs)} without the same crash\n\nResult:\nCrash not reproduced\n\nThis strengthens ${action.targetName || "the suspect"} as a suspect but does not prove causation.`,
      keepLabel: action.type === ACTION_TYPES.DISABLE_MOD_AND_RETEST ? "Keep disabled" : "Keep this state",
      restoreLabel: action.type === ACTION_TYPES.ROLLBACK_MOD_AND_RETEST ? "Restore previous version" : "Restore mod",
    };
  }
  return {
    title: "Retest incomplete",
    body: (action.retest && action.retest.summary) || "There is not enough evidence to classify this retest.",
    keepLabel: "",
    restoreLabel: "Restore previous state",
  };
}

function formatDuration(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function buttonLabel(type) {
  const map = {
    [ACTION_TYPES.DISABLE_MOD_AND_RETEST]: "Disable & Retest",
    [ACTION_TYPES.ROLLBACK_MOD_AND_RETEST]: "Restore Previous Version",
    [ACTION_TYPES.REPAIR_MOD_AND_RETEST]: "Repair Mod",
    [ACTION_TYPES.REPAIR_EXISTING_DEPENDENCY]: "Repair Dependency",
    [ACTION_TYPES.CLOSE_OVERLAY_AND_RETEST]: "Close Overlay & Retest",
    [ACTION_TYPES.RE_ENABLE_MOD]: "Re-enable Dependency",
    [ACTION_TYPES.MINIMAL_RETEST]: "Minimal Retest",
    [ACTION_TYPES.OPEN_DEPENDENCY_DETAILS]: "Dependency Details",
    [ACTION_TYPES.RESTORE_PREVIOUS_STATE]: "Restore Previous State",
  };
  return map[type] || type;
}

module.exports = {
  STALE_COPY,
  ACTION_STATES,
  actionAvailable,
  confirmationCopy,
  pendingBanner,
  retestResultCopy,
  formatDuration,
  buttonLabel,
};
