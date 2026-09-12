const { WEIGHTS, SUSPECT_TYPES } = require("./crashTypes");
const { enabledMods } = require("./sessionComparator");

function detectRegressions(target, comparison) {
  const findings = [];
  const targetMods = enabledMods(target);
  const lastIds = new Set((comparison.lastClean && enabledMods(comparison.lastClean) || []).map((mod) => mod.installId));
  const modsUnchanged =
    targetMods.every((mod) => lastIds.has(mod.installId)) &&
    lastIds.size === targetMods.length &&
    comparison.versionChanges.length === 0;

  if (comparison.lastClean && comparison.gtaChanged && modsUnchanged) {
    findings.push({
      type: SUSPECT_TYPES.CORE_COMPONENT,
      id: "gta-version",
      name: "Possible GTA update compatibility regression",
      score: WEIGHTS.GAME_UPDATE_REGRESSION,
      reasons: [
        `Last clean session used GTA ${comparison.lastCleanEnv.gtaVersion}; this session used ${comparison.targetEnv.gtaVersion}.`,
        "Enabled mods did not change between the last clean session and this failure.",
      ],
      counterEvidence: [],
    });
  }
  if (comparison.lastClean && comparison.rphChanged) {
    findings.push({
      type: SUSPECT_TYPES.CORE_COMPONENT,
      id: "rph-version",
      name: "Possible RAGE Plugin Hook version regression",
      score: WEIGHTS.CORE_VERSION_REGRESSION,
      reasons: [
        `RPH changed from ${comparison.lastCleanEnv.rphVersion} to ${comparison.targetEnv.rphVersion} immediately before failures.`,
      ],
      counterEvidence: ["A version change raises suspicion; it does not prove the hook caused the crash."],
    });
  }
  if (comparison.lastClean && comparison.lspdfrChanged) {
    findings.push({
      type: SUSPECT_TYPES.CORE_COMPONENT,
      id: "lspdfr-version",
      name: "Possible LSPDFR version regression",
      score: WEIGHTS.CORE_VERSION_REGRESSION,
      reasons: [
        `LSPDFR changed from ${comparison.lastCleanEnv.lspdfrVersion} to ${comparison.targetEnv.lspdfrVersion} immediately before failures.`,
      ],
      counterEvidence: ["A version change raises suspicion; it does not prove LSPDFR caused the crash."],
    });
  }
  return findings;
}

function versionRegressionFor(installId, presence) {
  const versions = Object.entries(presence.versions || {});
  if (versions.length < 2) return null;
  const cleanHeavy = versions.filter(([, row]) => row.clean > 0 && row.failed === 0);
  const failHeavy = versions.filter(([, row]) => row.failed > 0 && row.clean === 0);
  if (!cleanHeavy.length || !failHeavy.length) return null;
  return {
    from: cleanHeavy[0][0],
    to: failHeavy[0][0],
    cleanCount: cleanHeavy[0][1].clean,
    failedCount: failHeavy[0][1].failed,
  };
}

module.exports = { detectRegressions, versionRegressionFor };
