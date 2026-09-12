// Guided, read-only "Troubleshoot Duty" flow. It never applies anything; it
// gathers existing evidence and suggests ONE next action.

function run(context = {}) {
  const tests = context.tests || null;
  const analysis = context.lastCrashAnalysis || null;
  const profile = context.profile || null;
  const modHealth = context.modHealth || [];
  const missingRequiredDeps = context.missingRequiredDeps || [];

  const steps = [];
  const add = (id, title, detail, status = "info") => steps.push({ id, title, detail, status });

  // 1. Health
  if (tests) {
    const status = tests.verdict === "ready" ? "ok" : tests.verdict === "caution" ? "warn" : "bad";
    add("health", "Function test", tests.summary, status);
  } else {
    add("health", "Function test", "Run the function test to check core launch files.", "info");
  }

  // 2. Blocking issues
  const blocking = ((tests && tests.checks) || []).filter((c) => !c.ok && c.level === "bad");
  const broken = modHealth.filter((m) => m.status === "BROKEN");
  if (blocking.length || broken.length) {
    const details = [
      ...blocking.map((c) => c.title),
      ...broken.map((m) => (m.reasons || [])[0] || "Broken mod"),
    ];
    add("blocking", "Blocking issues", details.join(" · "), "bad");
  } else {
    add("blocking", "Blocking issues", "No launch-blocking issues found.", "ok");
  }

  // 3. Last crash
  if (analysis) {
    const top = (analysis.suspects || [])[0];
    if (analysis.analysisConfidence === "UNKNOWN" || !top) {
      add("crash", "Last crash", "The last crash has no clear cause yet.", "warn");
    } else {
      add("crash", "Last crash", `Strongest suspect: ${top.name} (${top.confidence}). This is a suspect, not proof.`, "warn");
    }
  } else {
    add("crash", "Last crash", "No recent crash analysis.", "ok");
  }

  // 4. Profile drift
  if (profile && profile.drift && profile.drift.drifted) {
    add("drift", "Profile drift", `${profile.profile ? profile.profile.name : "Active profile"} differs from the current Duty setup.`, "warn");
  } else {
    add("drift", "Profile drift", "Active profile matches the current setup.", "ok");
  }

  // 5. Dependencies
  if (missingRequiredDeps.length) {
    add("deps", "Dependencies", `${missingRequiredDeps.length} required dependency issue(s).`, "bad");
  } else {
    add("deps", "Dependencies", "No missing required dependencies.", "ok");
  }

  const suggestion = suggestNext({ tests, analysis, profile, broken, missingRequiredDeps });
  return { steps, suggestion };
}

function suggestNext({ tests, analysis, profile, broken, missingRequiredDeps }) {
  if (tests && tests.blocking > 0) {
    return { title: "Fix the launch-blocking issue first", detail: (tests.checks || []).find((c) => !c.ok && c.level === "bad")?.detail || tests.summary, action: "RUN_HEALTH" };
  }
  if (broken && broken.length) {
    return { title: "Repair or disable the broken mod", detail: (broken[0].reasons || [])[0] || "A managed mod is broken.", action: "OPEN_MODS" };
  }
  if (missingRequiredDeps.length) {
    return { title: "Install the missing required dependency", detail: `${missingRequiredDeps[0].name || missingRequiredDeps[0]} is required.`, action: "OPEN_MODS" };
  }
  if (analysis && (analysis.analysisConfidence === "UNKNOWN" || !(analysis.suspects || [])[0])) {
    return {
      title: "No clear cause — narrow it down safely",
      detail: "1) Switch to your known-good profile. 2) Retest. 3) Re-enable recent changes one at a time.",
      action: "RESTORE_KNOWN_GOOD",
      steps: ["Switch to known-good profile", "Retest with Play LSPDFR", "Re-enable recent changes one at a time"],
    };
  }
  if (profile && profile.drift && profile.drift.drifted) {
    return { title: "Resolve profile drift", detail: "Update the profile to match the current setup, or restore the profile.", action: "OPEN_PROFILES" };
  }
  if (analysis && (analysis.suspects || [])[0]) {
    return { title: "Test the strongest suspect", detail: `Try a reversible Disable & Retest on ${analysis.suspects[0].name}.`, action: "OPEN_CRASH" };
  }
  return { title: "Everything looks healthy", detail: "No action needed right now.", action: "NONE" };
}

module.exports = { run, suggestNext };
