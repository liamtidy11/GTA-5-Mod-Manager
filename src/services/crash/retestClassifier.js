const {
  RETEST_OUTCOMES,
  CRASH_RESULTS,
  MIN_ACTIVE_MS,
  MIN_SHORT_CRASH_RETEST_MS,
  NEVER_SUCCESS_BELOW_MS,
} = require("./crashActionTypes");

function requiredRetestMs(originalDurationMs) {
  const original = Math.max(0, Number(originalDurationMs) || 0);
  if (original > 0 && original < 2 * 60 * 1000) {
    return Math.max(original * 3, MIN_SHORT_CRASH_RETEST_MS);
  }
  if (original > 0) return Math.max(original + 5 * 60 * 1000, MIN_ACTIVE_MS);
  return MIN_ACTIVE_MS;
}

function classifyRetest(originalSession = {}, retestSession = {}) {
  const result = retestSession.result;
  if (result === "LAUNCH_FAILED") {
    return {
      outcome: RETEST_OUTCOMES.LAUNCH_FAILED,
      confidence: "MEDIUM",
      summary: "Test change was applied, but LSPDFR did not launch.",
    };
  }
  if (CRASH_RESULTS.has(result)) {
    return {
      outcome: RETEST_OUTCOMES.CRASH_REPRODUCED,
      confidence: "MEDIUM",
      summary: "The same crash occurred during the retest. This weakens the tested change as the primary suspect.",
    };
  }
  const durationMs = Math.max(0, Number(retestSession.durationMs) || 0);
  const needed = requiredRetestMs(originalSession.durationMs);
  if (result === "CLEAN_EXIT" && durationMs >= needed && durationMs >= NEVER_SUCCESS_BELOW_MS) {
    return {
      outcome: RETEST_OUTCOMES.NO_CRASH_OBSERVED,
      confidence: "MEDIUM",
      summary: "Crash was not observed after the test change. This strengthens the suspect but does not prove causation.",
    };
  }
  return {
    outcome: RETEST_OUTCOMES.UNKNOWN,
    confidence: "LOW",
    summary:
      durationMs < NEVER_SUCCESS_BELOW_MS
        ? "The retest was too short to treat as a successful run."
        : "The retest ended without enough evidence to classify the outcome.",
  };
}

module.exports = { classifyRetest, requiredRetestMs };
