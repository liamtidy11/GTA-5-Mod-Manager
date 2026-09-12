const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, cleanup } = require("./helpers");
const store = require("../src/services/session/sessionStore");
const { analyzeLogText, PATTERNS } = require("../src/services/crash/logPatternAnalyzer");
const { analyzeSession, getAnalysis, freshness, canAnalyze, analysisPath } = require("../src/services/crash/crashAnalyzer");
const { scoreMods } = require("../src/services/crash/suspectScorer");
const { buildEvidence } = require("../src/services/crash/evidenceBuilder");
const { compareSessions } = require("../src/services/crash/sessionComparator");
const { WEIGHTS, ANALYZER_VERSION, RULES_VERSION } = require("../src/services/crash/crashTypes");

const FIX = path.join(__dirname, "fixtures", "crash-logs");

function session(id, overrides = {}) {
  return {
    sessionId: id,
    startedAt: overrides.startedAt || "2026-01-01T12:00:00.000Z",
    endedAt: overrides.endedAt || "2026-01-01T12:01:00.000Z",
    durationMs: overrides.durationMs == null ? 60000 : overrides.durationMs,
    state: overrides.state || "CRASHED",
    result: overrides.result || "RPH_CRASH",
    confidence: overrides.confidence || "MEDIUM",
    environment: {
      gtaVersion: "1.0",
      rphVersion: "1.110",
      lspdfrVersion: "0.4.9",
      ...(overrides.environment || {}),
    },
    mods: overrides.mods || [mod("stp", "Stop The Ped", "1.0")],
    recentChanges: overrides.recentChanges || [],
    processes: overrides.processes || { atLaunch: [] },
    overlays: overrides.overlays || { atLaunch: {}, nvidiaDetected: false },
    logs: overrides.logs || [],
    copiedLogs: overrides.copiedLogs || [],
    logText: overrides.logText != null ? overrides.logText : "",
    dependencies: overrides.dependencies || [],
    timeline: overrides.timeline || [],
  };
}

function mod(installId, name, version, extra = {}) {
  return {
    installId,
    name,
    version,
    enabled: extra.enabled !== false,
    compatibility: extra.compatibility || "UNKNOWN",
    canonicalModId: extra.canonicalModId || "",
    dllNames: extra.dllNames || [],
  };
}

function analyze(target, history = [], extras = {}) {
  return analyzeSession(target.sessionId, {
    session: target,
    history,
    persist: false,
    now: () => "2026-01-01T13:00:00.000Z",
    ...extras,
  });
}

function findSuspect(result, nameOrId) {
  return (result.suspects || []).find(
    (row) => row.installId === nameOrId || row.name === nameOrId || row.id === nameOrId
  );
}

test("declarative log patterns: plugin, dependency, timeout, graphics, config", () => {
  const ids = PATTERNS.map((row) => row.id);
  for (const needed of [
    "PLUGIN_EXCEPTION",
    "DLL_LOAD_FAILURE",
    "MISSING_DEPENDENCY",
    "TIMEOUT",
    "FATAL_RPH",
    "LSPDFR_INIT_FAILURE",
    "GRAPHICS_D3D",
    "ACCESS_VIOLATION",
    "FILE_NOT_FOUND",
    "INVALID_CONFIG",
  ]) {
    assert.ok(ids.includes(needed), needed);
  }
  const named = analyzeLogText(fs.readFileSync(path.join(FIX, "plugin-exception.log"), "utf8"));
  assert.ok(named.namedModules.some((name) => /StopThePed\.dll/i.test(name)));
  assert.equal(named.lastLoaded, "StopThePed.dll");
  const missing = analyzeLogText(fs.readFileSync(path.join(FIX, "missing-dependency.log"), "utf8"));
  assert.ok(missing.namedModules.some((name) => /LemonUI/i.test(name)));
  const gfx = analyzeLogText(fs.readFileSync(path.join(FIX, "graphics.log"), "utf8"));
  assert.ok(gfx.matches.some((row) => row.id === "GRAPHICS_D3D"));
});

test("exact plugin exception maps to a strong HIGH suspect", () => {
  const target = session("fail-named", {
    logText: fs.readFileSync(path.join(FIX, "plugin-exception.log"), "utf8"),
    recentChanges: [{ installId: "stp", event: "UPDATED", at: "2026-01-01T11:48:00.000Z" }],
  });
  const result = analyze(target);
  const suspect = findSuspect(result, "stp");
  assert.ok(suspect);
  assert.equal(suspect.type, "MOD");
  assert.ok(suspect.score >= 75);
  assert.equal(suspect.confidence, "HIGH");
  assert.equal(result.analysisConfidence, "HIGH");
  assert.match(result.summary, /strongest current suspect/i);
  assert.doesNotMatch(result.summary, /caused the crash/i);
  assert.ok(result.recommendedTests.every((row) => row.execute === false));
});

test("recent install alone is a weak suspect", () => {
  const target = session("fail-recent", {
    logText: fs.readFileSync(path.join(FIX, "no-signal.log"), "utf8"),
    recentChanges: [{ installId: "stp", event: "INSTALL_COMMITTED", at: "2026-01-01T11:50:00.000Z" }],
  });
  const comparison = compareSessions(target, []);
  const evidence = buildEvidence(target, comparison);
  const scored = scoreMods(target, evidence, []);
  const stp = scored.find((row) => row.installId === "stp");
  assert.ok(stp);
  assert.ok(stp.score < 25);
  assert.equal(stp.confidence, "WEAK");
  const result = analyze(target);
  assert.equal(findSuspect(result, "stp"), undefined);
});

test("clean-session counter-evidence lowers score", () => {
  const failed = session("fail-counter", {
    logText: "",
    recentChanges: [{ installId: "stp", event: "UPDATED", at: "2026-01-01T11:50:00.000Z" }],
    mods: [mod("stp", "Stop The Ped", "1.0", { compatibility: "NOT_RECOMMENDED" })],
  });
  const cleans = [1, 2, 3].map((n) =>
    session(`clean-${n}`, {
      result: "CLEAN_EXIT",
      state: "COMPLETED",
      startedAt: `2026-01-0${n}T10:00:00.000Z`,
      mods: [mod("stp", "Stop The Ped", "1.0")],
    })
  );
  const comparison = compareSessions(failed, []);
  const alone = scoreMods(failed, buildEvidence(failed, comparison), []).find((row) => row.installId === "stp");
  const withClean = scoreMods(failed, buildEvidence(failed, compareSessions(failed, cleans)), cleans).find(
    (row) => row.installId === "stp"
  );
  assert.ok(withClean.score < alone.score);
  assert.ok(withClean.counterEvidence.some((row) => /successful session/i.test(row)));
});

test("repeated failed-session correlation raises score", () => {
  const fails = [1, 2, 3, 4, 5].map((n) =>
    session(`fail-rep-${n}`, {
      startedAt: `2026-02-0${n}T12:00:00.000Z`,
      mods: [mod("newmod", "New Callouts", "1.0")],
      logText: "",
    })
  );
  const target = fails[4];
  const history = fails.slice(0, 4);
  const result = analyze(target, history);
  const suspect = findSuspect(result, "newmod");
  assert.ok(suspect);
  assert.ok(suspect.score >= 25);
  assert.match(suspect.reasons.join(" "), /5 failed/);
});

test("mod version regression is detected from local history", () => {
  const cleans = [1, 2, 3].map((n) =>
    session(`clean-ver-${n}`, {
      result: "CLEAN_EXIT",
      state: "COMPLETED",
      startedAt: `2026-01-0${n}T10:00:00.000Z`,
      mods: [mod("ub", "Ultimate Backup", "1.7")],
    })
  );
  const fails = [1, 2, 3, 4].map((n) =>
    session(`fail-ver-${n}`, {
      startedAt: `2026-02-0${n}T12:00:00.000Z`,
      mods: [mod("ub", "Ultimate Backup", "1.8")],
    })
  );
  const result = analyze(fails[3], [...cleans, ...fails.slice(0, 3)]);
  const suspect = findSuspect(result, "ub");
  assert.ok(suspect);
  assert.match(suspect.reasons.join(" "), /1\.7/);
  assert.match(suspect.reasons.join(" "), /1\.8/);
  assert.doesNotMatch(suspect.reasons.join(" "), /caused the crash/i);
});

test("overlay history correlation ranks a system suspect", () => {
  const cleans = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    session(`clean-ov-${n}`, {
      result: "CLEAN_EXIT",
      state: "COMPLETED",
      startedAt: `2026-01-0${n}T10:00:00.000Z`,
      overlays: { atLaunch: { nvidiaOverlay: false }, nvidiaDetected: false },
    })
  );
  const fails = [1, 2, 3, 4, 5].map((n) =>
    session(`fail-ov-${n}`, {
      startedAt: `2026-02-0${n}T12:00:00.000Z`,
      overlays: { atLaunch: { nvidiaOverlay: true }, nvidiaDetected: true },
      processes: { atLaunch: [{ image: "NVIDIA Overlay.exe", running: true }] },
    })
  );
  const result = analyze(fails[4], [...cleans, ...fails.slice(0, 4)]);
  const overlay = result.suspects.find((row) => row.type === "OVERLAY");
  assert.ok(overlay);
  assert.ok(overlay.score >= 50);
  assert.match(overlay.reasons.join(" "), /failed sessions/);
});

test("missing required dependency is meaningful; optional does not dominate", () => {
  const required = session("fail-dep", {
    mods: [mod("callouts", "Example Callouts", "2.0")],
    dependencies: [{ id: "lemonui", name: "LemonUI", required: true, status: "MISSING", present: false }],
  });
  const req = analyze(required);
  const dep = req.suspects.find((row) => row.type === "DEPENDENCY");
  assert.ok(dep);
  assert.ok(dep.score >= 40);

  const optional = session("fail-opt", {
    mods: [mod("callouts", "Example Callouts", "2.0")],
    dependencies: [{ id: "ub", name: "Ultimate Backup", required: false, status: "MISSING", present: false }],
    logText: fs.readFileSync(path.join(FIX, "plugin-exception.log"), "utf8"),
  });
  optional.mods.push(mod("stp", "Stop The Ped", "1.0"));
  const opt = analyze(optional);
  const optionalHit = opt.suspects.find((row) => row.name === "Ultimate Backup");
  const named = findSuspect(opt, "stp");
  assert.ok(named);
  assert.ok(!optionalHit || optionalHit.score < named.score);
});

test("disabled required dependency is crash evidence", () => {
  const result = analyze(
    session("fail-dis", {
      dependencies: [{ id: "lemonui", name: "LemonUI", required: true, status: "DISABLED", enabled: false }],
    })
  );
  const dep = result.suspects.find((row) => row.type === "DEPENDENCY" && row.name === "LemonUI");
  assert.ok(dep);
  assert.ok(dep.score >= 40);
});

test("GTA, RPH, and LSPDFR version regressions surface without blaming a mod", () => {
  const clean = session("clean-gta", {
    result: "CLEAN_EXIT",
    state: "COMPLETED",
    startedAt: "2026-01-01T10:00:00.000Z",
    environment: { gtaVersion: "1.0", rphVersion: "1.110", lspdfrVersion: "0.4.9" },
    mods: [mod("stp", "Stop The Ped", "1.0")],
  });
  const gta = analyze(
    session("fail-gta", {
      startedAt: "2026-01-02T12:00:00.000Z",
      environment: { gtaVersion: "1.1", rphVersion: "1.110", lspdfrVersion: "0.4.9" },
      mods: [mod("stp", "Stop The Ped", "1.0")],
    }),
    [clean]
  );
  assert.ok(gta.suspects.some((row) => /GTA update compatibility/i.test(row.name)));

  const rph = analyze(
    session("fail-rph", {
      startedAt: "2026-01-02T12:00:00.000Z",
      environment: { gtaVersion: "1.0", rphVersion: "1.120", lspdfrVersion: "0.4.9" },
      mods: [mod("stp", "Stop The Ped", "1.0")],
    }),
    [clean]
  );
  assert.ok(rph.suspects.some((row) => /RAGE Plugin Hook version/i.test(row.name)));

  const lspdfr = analyze(
    session("fail-lsp", {
      startedAt: "2026-01-02T12:00:00.000Z",
      environment: { gtaVersion: "1.0", rphVersion: "1.110", lspdfrVersion: "0.5.0" },
      mods: [mod("stp", "Stop The Ped", "1.0")],
    }),
    [clean]
  );
  assert.ok(lspdfr.suspects.some((row) => /LSPDFR version/i.test(row.name)));
});

test("unknown DLL is shown without inventing an identity", () => {
  const result = analyze(
    session("fail-unknown", {
      logText: fs.readFileSync(path.join(FIX, "unknown-dll.log"), "utf8"),
      mods: [mod("stp", "Stop The Ped", "1.0")],
    })
  );
  const unknown = result.suspects.find((row) => row.type === "UNKNOWN");
  assert.ok(unknown);
  assert.match(unknown.name, /Unknown plugin\/component:\s*MysteryHook\.dll/i);
  assert.doesNotMatch(unknown.name, /Stop The Ped/);
});

test("multiple suspects are ranked and alternatives are preserved", () => {
  const cleans = [1, 2, 3].map((n) =>
    session(`clean-multi-${n}`, {
      result: "CLEAN_EXIT",
      state: "COMPLETED",
      startedAt: `2026-01-0${n}T10:00:00.000Z`,
      overlays: { atLaunch: { nvidiaOverlay: false }, nvidiaDetected: false },
      mods: [mod("stp", "Stop The Ped", "1.0")],
    })
  );
  const fails = [1, 2, 3].map((n) =>
    session(`fail-multi-${n}`, {
      startedAt: `2026-02-0${n}T12:00:00.000Z`,
      overlays: { atLaunch: { nvidiaOverlay: true }, nvidiaDetected: true },
      mods: [mod("stp", "Stop The Ped", "1.0")],
    })
  );
  const target = session("fail-multi-target", {
    startedAt: "2026-02-04T12:00:00.000Z",
    logText: fs.readFileSync(path.join(FIX, "plugin-exception.log"), "utf8"),
    overlays: { atLaunch: { nvidiaOverlay: true }, nvidiaDetected: true },
    mods: [mod("stp", "Stop The Ped", "1.0")],
    dependencies: [{ id: "lemonui", name: "LemonUI", required: true, status: "MISSING", present: false }],
    recentChanges: [{ installId: "stp", event: "UPDATED", at: "2026-02-04T11:00:00.000Z" }],
  });
  const result = analyze(target, [...cleans, ...fails]);
  assert.ok(result.suspects.length >= 2);
  assert.ok(result.suspects[0].score >= result.suspects[1].score);
  assert.equal(findSuspect(result, "stp").confidence, "HIGH");
  assert.ok(result.alternatives.length >= 1);
});

test("no useful evidence yields UNKNOWN and no invented cause", () => {
  const result = analyze(
    session("fail-none", {
      logText: fs.readFileSync(path.join(FIX, "no-signal.log"), "utf8"),
      mods: [mod("stp", "Stop The Ped", "1.0"), mod("ub", "Ultimate Backup", "1.7")],
    })
  );
  assert.equal(result.analysisConfidence, "UNKNOWN");
  assert.match(result.summary, /do not name a failing plugin|not enough session history/i);
  assert.ok(result.recommendedTests.some((row) => /recently changed mods disabled/i.test(row.text)));
  assert.ok(result.suspects.every((row) => row.confidence !== "HIGH"));
});

test("analysis persists locally and does not change mods", () => {
  const root = tmpDir("crash-persist-");
  const target = session("persist-1", {
    logText: fs.readFileSync(path.join(FIX, "plugin-exception.log"), "utf8"),
  });
  const modsBefore = JSON.stringify(target.mods);
  store.createSession(root, target);
  const result = analyzeSession(target.sessionId, { root, now: () => "2026-01-01T13:00:00.000Z" });
  assert.equal(fs.existsSync(analysisPath(root, target.sessionId)), true);
  const stored = getAnalysis(root, target.sessionId);
  assert.equal(stored.analyzerVersion, ANALYZER_VERSION);
  assert.equal(stored.rulesVersion, RULES_VERSION);
  assert.ok(stored.evidence.fingerprint);
  assert.equal(stored.sessionId, result.sessionId);
  assert.equal(JSON.stringify(store.getSession(root, target.sessionId).mods), modsBefore);
  assert.ok(result.recommendedTests.every((row) => row.execute === false));
  cleanup(root);
});

test("stale analysis is detected when session evidence changes", () => {
  const root = tmpDir("crash-stale-");
  const target = session("stale-1", {
    logText: fs.readFileSync(path.join(FIX, "plugin-exception.log"), "utf8"),
    logs: [{ name: "RagePluginHook.log", hash: "aaa" }],
  });
  store.createSession(root, target);
  analyzeSession(target.sessionId, { root });
  assert.equal(freshness(root, target.sessionId).status, "CURRENT");
  store.updateSession(root, target.sessionId, { logs: [{ name: "RagePluginHook.log", hash: "bbb" }] });
  const next = freshness(root, target.sessionId);
  assert.equal(next.status, "STALE");
  assert.equal(next.analysis.stale, true);
  cleanup(root);
});

test("rules versioning marks older analysis stale", () => {
  const root = tmpDir("crash-rules-");
  const target = session("rules-1", { logText: "Unhandled exception in StopThePed.dll" });
  store.createSession(root, target);
  analyzeSession(target.sessionId, { root });
  const file = analysisPath(root, target.sessionId);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.rulesVersion = "0";
  fs.writeFileSync(file, JSON.stringify(stored, null, 2));
  assert.equal(freshness(root, target.sessionId).status, "STALE");
  cleanup(root);
});

test("canAnalyze is conservative and clean sessions are not crash cases", () => {
  assert.equal(canAnalyze(session("a", { result: "RPH_CRASH" })), true);
  assert.equal(canAnalyze(session("b", { result: "UNKNOWN" })), true);
  assert.equal(canAnalyze(session("c", { result: "CLEAN_EXIT", state: "COMPLETED" })), false);
  assert.ok(WEIGHTS.NAMED_PLUGIN_EXCEPTION >= 75);
  assert.ok(WEIGHTS.ENABLED_ONLY < 25);
});
