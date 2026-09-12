function recommendTests(suspects = [], analysisConfidence) {
  const tests = [];
  const seen = new Set();
  for (const suspect of suspects.slice(0, 4)) {
    let text = "";
    if (suspect.type === "MOD") text = `Disable ${suspect.name} and relaunch. Do not uninstall yet.`;
    else if (suspect.type === "DEPENDENCY") text = `Repair or enable ${suspect.name}, then relaunch.`;
    else if (suspect.type === "OVERLAY") text = `Close ${suspect.name} and retest without changing mods.`;
    else if (suspect.type === "GRAPHICS_HOOK") text = "Close overlays and graphics hooks, then relaunch.";
    else if (suspect.type === "CORE_COMPONENT") text = "Retest with the previous GTA / RPH / LSPDFR versions if you still have them; do not change mods first.";
    else if (suspect.type === "UNKNOWN") text = `Note the unknown component ${suspect.name} and launch with recently changed mods disabled.`;
    else text = "Launch with recently changed mods disabled.";
    if (text && !seen.has(text)) {
      seen.add(text);
      tests.push({ id: suspect.id || suspect.installId || suspect.name, text, execute: false });
    }
  }
  if (!tests.length || analysisConfidence === "UNKNOWN") {
    tests.push({
      id: "recent-changes",
      text: "Launch with recently changed mods disabled.",
      execute: false,
    });
  }
  return tests;
}

function alternatives(suspects, comparison, analysisConfidence) {
  const rows = [];
  if (comparison.gtaChanged) rows.push("GTA update compatibility");
  if (comparison.rphChanged) rows.push("RAGE Plugin Hook version change");
  if (comparison.lspdfrChanged) rows.push("LSPDFR version change");
  if (comparison.overlayOn) rows.push("Graphics overlay conflict");
  if (analysisConfidence !== "HIGH") {
    if (!rows.includes("Insufficient log detail")) rows.push("Insufficient log detail");
  }
  for (const suspect of suspects.slice(1, 4)) {
    rows.push(suspect.name);
  }
  return [...new Set(rows)].slice(0, 6);
}

module.exports = { recommendTests, alternatives };
