const { WEIGHTS, SUSPECT_TYPES } = require("./crashTypes");

function analyzeDependencies(session, namedModules = []) {
  const findings = [];
  const deps = session.dependencies || [];
  for (const dep of deps) {
    const required = dep.required === true;
    const missing = dep.status === "MISSING" || dep.present === false;
    const disabled = dep.enabled === false || dep.status === "DISABLED";
    const tooOld = dep.status === "TOO_OLD";
    if (!required && !namedModules.some((name) => matchesDep(name, dep))) continue;
    if (required && missing) {
      findings.push(depFinding(dep, WEIGHTS.REQUIRED_DEP_MISSING, `Required dependency ${dep.name} was missing.`));
    } else if (required && disabled) {
      findings.push(depFinding(dep, WEIGHTS.REQUIRED_DEP_DISABLED, `Required dependency ${dep.name} was disabled.`));
    } else if (required && tooOld) {
      findings.push(depFinding(dep, WEIGHTS.REQUIRED_DEP_MISSING, `Required dependency ${dep.name} is installed but too old.`));
    } else if (!required && missing) {
      findings.push(depFinding(dep, WEIGHTS.OPTIONAL_DEP_MISSING, `Optional dependency ${dep.name} was missing.`));
    }
  }
  for (const name of namedModules) {
    if (!/LemonUI|RAGENativeUI|iFruitAddon2/i.test(name)) continue;
    if (findings.some((row) => matchesDep(name, { name: row.name, id: row.id }))) continue;
    findings.push({
      type: SUSPECT_TYPES.DEPENDENCY,
      id: `dep-named:${name}`,
      name,
      score: WEIGHTS.NAMED_DEPENDENCY_LOAD,
      reasons: [`A loader failure named ${name}.`],
      counterEvidence: [],
    });
  }
  return findings;
}

function depFinding(dep, score, reason) {
  return {
    type: SUSPECT_TYPES.DEPENDENCY,
    id: dep.id || dep.name,
    name: dep.name,
    score,
    reasons: [reason],
    counterEvidence: requiredOptionalNote(dep),
  };
}

function requiredOptionalNote(dep) {
  if (dep.required === false) return ["Optional missing dependencies usually do not dominate crash ranking."];
  return [];
}

function matchesDep(name, dep) {
  const hay = `${dep.name || ""} ${dep.id || ""}`.toLowerCase();
  return hay.includes(String(name).toLowerCase().replace(/\.(dll|asi)$/i, ""));
}

module.exports = { analyzeDependencies };
