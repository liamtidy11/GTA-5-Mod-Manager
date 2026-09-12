// Decides, from local metrics only, whether Smart Install preview is stable
// enough to become the default. Never fakes readiness. The hands-off install
// path is never removed.

const DEFAULT_THRESHOLD = {
  minSuccessfulInstalls: 10,
  maxRollbackFailures: 0,
  maxAnalysisErrorRate: 0.1,
};

function evaluate(metrics = {}, threshold = DEFAULT_THRESHOLD) {
  const t = { ...DEFAULT_THRESHOLD, ...threshold };
  const successfulInstalls = Number(metrics.successfulInstalls || 0);
  const rollbackFailures = Number(metrics.rollbackFailures || 0);
  const analysisErrors = Number(metrics.analysisErrors || 0);
  const denominator = successfulInstalls + analysisErrors;
  const analysisErrorRate = denominator > 0 ? analysisErrors / denominator : 0;

  const reasons = [];
  let ready = true;

  if (successfulInstalls < t.minSuccessfulInstalls) {
    ready = false;
    reasons.push(`Only ${successfulInstalls} successful Smart Installs so far (need ${t.minSuccessfulInstalls}). Not enough evidence yet.`);
  }
  if (rollbackFailures > t.maxRollbackFailures) {
    ready = false;
    reasons.push(`${rollbackFailures} rollback failure(s) recorded. Preview default stays off until rollback is perfect.`);
  }
  if (analysisErrorRate > t.maxAnalysisErrorRate) {
    ready = false;
    reasons.push(`Analysis error rate is ${(analysisErrorRate * 100).toFixed(0)}% (max ${(t.maxAnalysisErrorRate * 100).toFixed(0)}%).`);
  }
  if (ready) reasons.push("Smart Install has a clean local track record. Preview-before-install can safely default on.");

  return {
    ready,
    reasons,
    metrics: { successfulInstalls, rollbackFailures, analysisErrors, blockedPackages: Number(metrics.blockedPackages || 0), analysisErrorRate },
  };
}

const PRESETS = {
  SAFE_PLUGIN_INSTALL: {
    id: "SAFE_PLUGIN_INSTALL",
    label: "Safe Plugin Install",
    snapshotBeforeInstall: true,
    configPolicy: "KEEP_EXISTING",
    driftBehavior: "MARK_DRIFT",
    launchAfter: false,
  },
  TESTING_INSTALL: {
    id: "TESTING_INSTALL",
    label: "Testing Install",
    snapshotBeforeInstall: true,
    configPolicy: "KEEP_EXISTING",
    driftBehavior: "MARK_DRIFT",
    launchAfter: true,
  },
};

function preset(id) {
  return PRESETS[id] ? { ...PRESETS[id] } : null;
}

// Whether to auto-create a safety snapshot before an install. Default ON for
// HIGH-risk updates; the user can disable via settings.
function shouldSnapshotBeforeInstall({ risk = "UNKNOWN", settings = {}, presetId = "" } = {}) {
  const chosen = preset(presetId);
  if (chosen && chosen.snapshotBeforeInstall) return true;
  const enabled = settings.snapshotBeforeRiskyInstall !== false; // default true
  return Boolean(enabled && risk === "HIGH");
}

module.exports = {
  DEFAULT_THRESHOLD,
  PRESETS,
  evaluate,
  preset,
  shouldSnapshotBeforeInstall,
};
