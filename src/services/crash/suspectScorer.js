const { WEIGHTS, COUNTERS, SUSPECT_TYPES, CORE_NAMES, scoreBand } = require("./crashTypes");
const { recentChangeFor } = require("./evidenceBuilder");
const { enabledMods, modPresence } = require("./sessionComparator");
const { versionRegressionFor } = require("./regressionAnalyzer");

function scoreMods(session, evidence, history) {
  const namedList = evidence.logs.namedModules || [];
  const named = new Set(namedList.map((name) => String(name).toLowerCase()));
  const lastLoaded = String(evidence.logs.lastLoaded || "").toLowerCase();
  const suspects = [];
  for (const mod of enabledMods(session)) {
    const mapped = namedModuleMatchesMod(mod, named);
    const pieces = [];
    const counters = [];
    if (mapped) {
      pieces.push({ weight: WEIGHTS.NAMED_PLUGIN_EXCEPTION, reason: `A session log names ${mapped} and maps to this installed mod.` });
    }
    if (lastLoaded && matchesName(lastLoaded, mod)) {
      pieces.push({
        weight: WEIGHTS.LAST_LOADED_BEFORE_FATAL,
        reason: `${mod.name} was the last successfully loaded component before a fatal error.`,
      });
    }
    const change = recentChangeFor(mod.installId, evidence.recentChanges);
    if (change && /INSTALLED|UPDATED|DOWNGRADED|REPAIRED|ENABLED/.test(change.action || "")) {
      pieces.push({
        weight: WEIGHTS.RECENT_UPDATE_OR_INSTALL,
        reason: recentChangeReason(change),
      });
    }
    const versionHit = (evidence.comparison && evidence.comparison.versionChanges || []).find(
      (row) => row.installId === mod.installId
    );
    const newlyEnabled = (evidence.comparison && evidence.comparison.newlyEnabled || []).some(
      (row) => row.installId === mod.installId
    );
    if (newlyEnabled && !change) {
      pieces.push({
        weight: WEIGHTS.NEWLY_ENABLED,
        reason: "This mod was not enabled in the last clean session. That is a change-point, not proof of cause.",
      });
    }
    if (mod.compatibility === "NOT_RECOMMENDED" || (mod.compatibility && /NOT_RECOMMENDED|WARNING/.test(mod.compatibility))) {
      pieces.push({
        weight: WEIGHTS.COMPAT_WARNING,
        reason: "This session launched with a compatibility warning already recorded for the mod.",
      });
    }
    const presence = modPresence(mod.installId, [...history, session]);
    const regression = versionRegressionFor(mod.installId, presence);
    if (regression || versionHit) {
      const from = (regression && regression.from) || (versionHit && versionHit.from);
      const to = (regression && regression.to) || (versionHit && versionHit.to);
      pieces.push({
        weight: WEIGHTS.VERSION_REGRESSION,
        reason: `Last known-good used ${mod.name} ${from}; this failed session used ${to}. Updated immediately before failures began.`,
      });
    }
    if (presence.failed >= 2 && presence.clean === 0) {
      const sampleBoost = presence.failed + presence.clean >= 4 ? WEIGHTS.REPEATED_FAIL_ONLY : Math.round(WEIGHTS.REPEATED_FAIL_ONLY * 0.6);
      pieces.push({
        weight: sampleBoost,
        reason: `${presence.failed} failed session(s) contained this mod and 0 clean sessions did.`,
      });
    }
    const retest = evidence.retestByInstall && evidence.retestByInstall[mod.installId];
    if (retest === "RETEST_NO_CRASH" || retest === "NO_CRASH_OBSERVED") {
      pieces.push({
        weight: 20,
        reason: "A later retest did not observe the same crash after this change. That strengthens suspicion; it does not prove cause.",
      });
    }
    if (retest === "RETEST_CRASH_REPRODUCED" || retest === "CRASH_REPRODUCED") {
      counters.push({
        weight: 20,
        reason: "A later retest still crashed after this change. That weakens this suspect.",
      });
    }
    if (evidence.durationMs && evidence.durationMs < 30000 && mapped) {
      pieces.push({
        weight: WEIGHTS.DURATION_DROP,
        reason: "This session ended quickly after the named plugin loaded. Duration is supporting evidence only.",
      });
    }
    if (!pieces.length) {
      pieces.push({ weight: WEIGHTS.ENABLED_ONLY, reason: "The mod was enabled. Presence alone is weak evidence." });
    }

    const sameVersionClean = (presence.versions[mod.version] && presence.versions[mod.version].clean) || 0;
    if (sameVersionClean >= 2 && !mapped && !regression && !versionHit) {
      counters.push({
        weight: COUNTERS.IN_MANY_CLEAN,
        reason: `The same mod version was enabled in ${sameVersionClean} earlier successful session(s).`,
      });
    } else if (presence.clean >= 2 && !mapped && !regression && !versionHit) {
      counters.push({
        weight: COUNTERS.IN_MANY_CLEAN,
        reason: `The same mod was enabled in ${presence.clean} earlier successful session(s).`,
      });
    } else if (presence.clean >= 2 && (regression || versionHit)) {
      counters.push({
        weight: 0,
        reason: `An older version of this mod appeared in ${presence.clean} successful session(s). That is counter-evidence against blaming the mod as a whole.`,
      });
    }
    if (change && /INSTALLED/.test(change.action || "") && crashPredates(change, session, history)) {
      counters.push({ weight: COUNTERS.PREDATES_INSTALL, reason: "Failures already existed before this mod was installed." });
    }
    if (named.size && !mapped) {
      counters.push({
        weight: COUNTERS.FATAL_NAMES_OTHER,
        reason: "A fatal log names another component, not this mod.",
      });
    }
    if (presence.failed + presence.clean <= 1 && !mapped) {
      counters.push({ weight: COUNTERS.SMALL_SAMPLE, reason: "Sample size is small; one session is limited evidence." });
    }

    let score = pieces.reduce((sum, row) => sum + row.weight, 0) - counters.reduce((sum, row) => sum + row.weight, 0);
    if (!mapped && score > 49 && pieces.every((row) => row.weight <= WEIGHTS.RECENT_UPDATE_OR_INSTALL || row.weight === WEIGHTS.ENABLED_ONLY)) {
      score = Math.min(score, 49);
    }
    score = Math.max(0, Math.min(100, score));
    suspects.push({
      type: SUSPECT_TYPES.MOD,
      installId: mod.installId,
      id: mod.installId,
      name: mod.name,
      version: mod.version || "UNKNOWN",
      score,
      confidence: scoreBand(score),
      reasons: pieces.map((row) => row.reason),
      counterEvidence: counters.map((row) => row.reason),
      weights: { added: pieces, subtracted: counters },
      sample: presence,
    });
  }

  for (const moduleName of namedList) {
    if (enabledMods(session).some((mod) => matchesName(moduleName, mod))) continue;
    if (CORE_NAMES.some((core) => String(moduleName).toLowerCase().includes(core))) {
      suspects.push({
        type: SUSPECT_TYPES.CORE_COMPONENT,
        id: `core:${moduleName}`,
        name: moduleName,
        score: WEIGHTS.CORE_NAMED,
        confidence: scoreBand(WEIGHTS.CORE_NAMED),
        reasons: [`A session log names core component ${moduleName}.`],
        counterEvidence: ["Core components are not blamed without this kind of explicit log evidence."],
        weights: { added: [{ weight: WEIGHTS.CORE_NAMED, reason: "Named core module" }], subtracted: [] },
      });
      continue;
    }
    suspects.push({
      type: SUSPECT_TYPES.UNKNOWN,
      id: `unknown:${moduleName}`,
      name: `Unknown plugin/component: ${moduleName}`,
      score: WEIGHTS.NAMED_PLUGIN_EXCEPTION,
      confidence: scoreBand(WEIGHTS.NAMED_PLUGIN_EXCEPTION),
      reasons: [`A fatal log names ${moduleName}, but it is not mapped to an installed mod.`],
      counterEvidence: ["Identity was not invented from the file name."],
      weights: { added: [{ weight: WEIGHTS.NAMED_PLUGIN_EXCEPTION, reason: "Named unknown module" }], subtracted: [] },
    });
  }
  return suspects;
}

function namedModuleMatchesMod(mod, named) {
  for (const name of named) {
    if (matchesName(name, mod)) return name;
  }
  return "";
}

function matchesName(moduleName, mod) {
  const needle = String(moduleName).toLowerCase().replace(/\.(dll|asi)$/i, "");
  const hay = [mod.name, mod.installId, mod.canonicalModId, ...(mod.dllNames || [])]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().replace(/\.(dll|asi)$/i, "").replace(/[\s_-]+/g, ""));
  const compact = needle.replace(/[\s_-]+/g, "");
  return hay.some((value) => value.includes(compact) || compact.includes(value));
}

function recentChangeReason(change) {
  if (change.action === "UPDATED") return "The mod was updated immediately before this session. That raises suspicion; it does not prove cause.";
  if (change.action === "INSTALLED") return "The mod was newly installed before this session. A recent change is not proof of cause.";
  if (change.action === "ENABLED") return "The mod was enabled shortly before this session.";
  return `A recent Smart Audit ${change.action} exists for this mod.`;
}

function crashPredates(change, session, history) {
  const when = Date.parse(change.at || change.createdAt || "") || 0;
  return (history || []).some((row) => {
    const started = Date.parse(row.startedAt || "") || 0;
    return started && when && started < when;
  });
}

module.exports = { scoreMods, matchesName };
