const fs = require("fs");
const path = require("path");
const sessionStore = require("../session/sessionStore");
const { ANALYZER_VERSION, RULES_VERSION, scoreBand, DISPLAY_THRESHOLD, FAILED_RESULTS, SUSPECT_TYPES } = require("./crashTypes");
const { buildEvidence, evidenceFingerprint } = require("./evidenceBuilder");
const { compareSessions } = require("./sessionComparator");
const { scoreMods } = require("./suspectScorer");
const { detectRegressions } = require("./regressionAnalyzer");
const { analyzeOverlays, analyzeGraphics } = require("./overlayAnalyzer");
const { analyzeDependencies } = require("./dependencyCrashAnalyzer");
const { recommendTests, alternatives } = require("./crashRecommendation");

function analyzeSession(sessionId, options = {}) {
  const session = options.session || sessionStore.getSession(options.root, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const history = options.history || loadHistory(options.root, sessionId);
  const comparison = compareSessions(session, history);
  const evidence = buildEvidence(session, comparison);
  if (options.actionRoot) {
    try {
      evidence.retestByInstall = require("./crashActions").retestEvidenceByInstall(options.actionRoot);
    } catch {
      evidence.retestByInstall = {};
    }
  }
  const suspects = [];

  suspects.push(...scoreMods(session, evidence, history));
  suspects.push(...analyzeDependencies(session, evidence.logs.namedModules));
  suspects.push(...analyzeOverlays(session, history));
  suspects.push(...analyzeGraphics(evidence.logs.matches));
  suspects.push(...detectRegressions(session, comparison));
  const configHit = evidence.logs.matches.find((row) => row.id === "INVALID_CONFIG");
  if (configHit) {
    suspects.push({
      type: SUSPECT_TYPES.CONFIGURATION,
      id: "invalid-config",
      name: "Invalid configuration",
      score: 30,
      reasons: [`A session log reports a configuration problem: ${configHit.excerpt}`],
      counterEvidence: ["A config warning is not proof that a specific mod crashed the session."],
    });
  }

  const profileFinding = profileCorrelation(session, history);
  if (profileFinding) suspects.push(profileFinding);

  const ranked = suspects
    .map((row) => ({
      ...row,
      score: Math.max(0, Math.min(100, row.score || 0)),
      confidence: row.confidence || scoreBand(row.score || 0),
    }))
    .filter((row) => row.score >= DISPLAY_THRESHOLD || row.type === "UNKNOWN")
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const analysisConfidence = overallConfidence(ranked, comparison, evidence);
  const summary = buildSummary(session, ranked, analysisConfidence);
  const createdAt = (options.now && options.now()) || new Date().toISOString();
  const analysis = {
    analyzerVersion: ANALYZER_VERSION,
    rulesVersion: RULES_VERSION,
    createdAt,
    sessionId: session.sessionId,
    result: session.result,
    analysisConfidence,
    summary,
    suspects: ranked,
    systemFindings: ranked.filter((row) => row.type !== "MOD"),
    alternatives: alternatives(ranked, comparison, analysisConfidence),
    recommendedTests: recommendTests(ranked, analysisConfidence),
    evidence: {
      fingerprint: evidence.fingerprint,
      logPatterns: evidence.logs.matches,
      namedModules: evidence.logs.namedModules,
      lastLoaded: evidence.logs.lastLoaded,
      sample: comparison.sample,
      lastCleanSessionId: comparison.lastClean && comparison.lastClean.sessionId,
      versionChanges: comparison.versionChanges,
    },
    stale: false,
  };

  if (options.persist !== false && options.root) {
    writeAnalysis(options.root, session.sessionId, analysis);
  }
  return analysis;
}

function profileCorrelation(session, history) {
  if (!session.profileId) return null;
  const others = history || [];
  const hereFailed = others.filter((row) => row.profileId === session.profileId && ["GAME_CRASH", "RPH_CRASH", "LSPDFR_CRASH"].includes(row.result)).length + 1;
  const otherClean = others.filter((row) => row.profileId && row.profileId !== session.profileId && row.result === "CLEAN_EXIT").length;
  if (hereFailed < 2 || otherClean < 2) return null;
  return {
    type: "RECENT_CHANGE",
    id: `profile:${session.profileId}`,
    name: "Profile switch correlation",
    score: 32,
    reasons: [
      `${hereFailed} failed sessions on this profile and ${otherClean} clean sessions on other profiles. That is correlation, not proof.`,
    ],
    counterEvidence: ["A profile change raises suspicion; it does not prove the profile caused the crash."],
  };
}

function loadHistory(root, sessionId) {
  if (!root) return [];
  return sessionStore
    .listSessions(root)
    .filter((row) => row.sessionId !== sessionId)
    .map((row) => sessionStore.getSession(root, row.sessionId))
    .filter(Boolean);
}

function overallConfidence(suspects, comparison, evidence) {
  if (!suspects.length) return "UNKNOWN";
  const top = suspects[0];
  const named = Boolean(evidence.logs.namedModules && evidence.logs.namedModules.length);
  const sample = (comparison.sample.clean || 0) + (comparison.sample.failed || 0);
  const corroborated = named || (top.sample && top.sample.failed >= 3) || (comparison.versionChanges || []).length > 0;
  if (top.confidence === "HIGH" && corroborated) return "HIGH";
  if (top.confidence === "HIGH") return "MEDIUM";
  if (top.confidence === "MEDIUM" || (suspects.filter((row) => row.score >= 50).length >= 2 && sample >= 2)) return "MEDIUM";
  if (top.score >= 25) return "LOW";
  return "UNKNOWN";
}

function buildSummary(session, suspects, analysisConfidence) {
  if (!suspects.length || analysisConfidence === "UNKNOWN") {
    return "The logs do not name a failing plugin and there is not enough session history to confidently rank one.";
  }
  const top = suspects[0];
  return `${top.name} is the strongest current suspect (${top.confidence.toLowerCase()} confidence). This is a likely cause, not a proven cause.`;
}

function analysisPath(root, sessionId) {
  return path.join(sessionStore.sessionDir(root, sessionId), "analysis.json");
}

function writeAnalysis(root, sessionId, analysis) {
  const file = analysisPath(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function getAnalysis(root, sessionId) {
  const file = analysisPath(root, sessionId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function freshness(root, sessionId, session) {
  const stored = getAnalysis(root, sessionId);
  if (!stored) return { status: "MISSING", analysis: null };
  const current = session || sessionStore.getSession(root, sessionId);
  if (!current) return { status: "MISSING", analysis: stored };
  const stale =
    stored.analyzerVersion !== ANALYZER_VERSION ||
    stored.rulesVersion !== RULES_VERSION ||
    stored.evidence?.fingerprint !== evidenceFingerprint(current);
  if (stale) {
    const already = stored.stale === true && stored.status === "STALE";
    stored.stale = true;
    stored.status = "STALE";
    if (!already && root) writeAnalysis(root, sessionId, stored);
    return { status: "STALE", analysis: stored };
  }
  return { status: "CURRENT", analysis: stored };
}

function attachAnalysis(root, session) {
  if (!session) return null;
  const { status, analysis } = freshness(root, session.sessionId, session);
  return { ...session, analysis, analysisStatus: status };
}

function compactAnalysis(analysis) {
  if (!analysis || analysis.stale) return null;
  const top = (analysis.suspects || [])[0];
  return {
    analysisConfidence: analysis.analysisConfidence,
    suspectName: top ? top.name : "",
    suspectConfidence: top ? top.confidence : "",
    summary: analysis.summary,
  };
}

function canAnalyze(session) {
  if (!session) return false;
  return FAILED_RESULTS.has(session.result) || session.state === "CRASHED" || session.state === "UNKNOWN";
}

module.exports = {
  analyzeSession,
  getAnalysis,
  freshness,
  canAnalyze,
  attachAnalysis,
  compactAnalysis,
  analysisPath,
  ANALYZER_VERSION,
  RULES_VERSION,
};
