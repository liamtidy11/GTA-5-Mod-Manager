const { WEIGHTS, SUSPECT_TYPES, CLEAN_RESULTS, FAILED_RESULTS } = require("./crashTypes");
const { overlayOn, overlayNames } = require("./sessionComparator");

function analyzeOverlays(target, history = []) {
  const names = overlayNames(target);
  if (!names.length && !overlayOn(target)) return [];
  const rows = [...history, target];
  const findings = [];
  for (const name of names.length ? names : ["Known overlay"]) {
    let failedOn = 0;
    let cleanOn = 0;
    let failedOff = 0;
    let cleanOff = 0;
    for (const session of rows) {
      const on = name === "Known overlay" ? overlayOn(session) : overlayNames(session).includes(name);
      if (CLEAN_RESULTS.has(session.result)) {
        if (on) cleanOn += 1;
        else cleanOff += 1;
      } else if (FAILED_RESULTS.has(session.result)) {
        if (on) failedOn += 1;
        else failedOff += 1;
      }
    }
    const historySignal = failedOn >= 2 && cleanOn === 0 && cleanOff >= 2;
    const strongHistory = failedOn >= 3 && cleanOff >= 3 && cleanOn === 0;
    const score = strongHistory
      ? WEIGHTS.OVERLAY_HISTORY_STRONG
      : historySignal
        ? WEIGHTS.OVERLAY_HISTORY
        : WEIGHTS.OVERLAY_PRESENT;
    const reasons = [];
    if (overlayOn(target) || names.includes(name)) {
      reasons.push(`${name} was recorded as running when this session launched.`);
    }
    if (historySignal) {
      reasons.push(
        `${name} was present in ${failedOn} failed sessions and absent in ${cleanOff} clean sessions.`
      );
    } else {
      reasons.push("Generic overlay conflict is possible, but local history is not strong enough to rank this highly.");
    }
    findings.push({
      type: SUSPECT_TYPES.OVERLAY,
      id: `overlay:${name}`,
      name,
      score,
      reasons,
      counterEvidence: cleanOn > 0 ? [`${name} was also present in ${cleanOn} clean session(s).`] : [],
      sample: { failedOn, cleanOn, failedOff, cleanOff },
    });
  }
  return findings;
}

function analyzeGraphics(logMatches) {
  const hit = (logMatches || []).find((row) => row.id === "GRAPHICS_D3D");
  if (!hit) return [];
  return [
    {
      type: SUSPECT_TYPES.GRAPHICS_HOOK,
      id: "graphics-hook",
      name: "Graphics / overlay hook evidence",
      score: WEIGHTS.NAMED_FATAL_PLUGIN - 20,
      reasons: [`Session logs contain graphics-hook evidence: ${hit.excerpt}`],
      counterEvidence: ["This is classified separately from plugin DLL failures."],
    },
  ];
}

module.exports = { analyzeOverlays, analyzeGraphics };
