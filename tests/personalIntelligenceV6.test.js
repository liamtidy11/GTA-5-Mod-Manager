const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeFile, makeFakeDuty, cleanup } = require("./helpers");
const smartInstall = require("../src/services/smartInstall");
const manifestStore = require("../src/services/manifestStore");
const { appendAudit, bumpMetric } = require("../src/services/smartAudit");
const config = require("../src/services/config");

const userKnowledge = require("../src/services/knowledge/userKnowledge");
const updateIntelligence = require("../src/services/update/updateIntelligence");
const modHealthV2 = require("../src/services/modHealthV2");
const dependencyGraph = require("../src/services/dependencyGraph");
const dutyHealthV2 = require("../src/services/dutyHealthV2");
const smartReadiness = require("../src/services/smartReadiness");
const troubleshoot = require("../src/services/troubleshoot");
const modSearch = require("../src/services/modSearch");
const { filterSessions } = require("../src/services/session/sessionFilter");
const storageManager = require("../src/services/storage/storageManager");
const managerBackup = require("../src/services/backup/managerBackup");
const profileRecommendation = require("../src/services/profiles/profileRecommendation");
const configIntelligence = require("../src/services/configIntelligence");
const { buildReport } = require("../src/services/diagnostics/report");
const { redact } = require("../src/services/diagnostics/redact");
const selfCheck = require("../src/services/diagnostics/selfCheck");
const profileStore = require("../src/services/profiles/profileStore");
const snapshotStore = require("../src/services/snapshots/snapshotStore");
const snapshotManager = require("../src/services/snapshots/snapshotManager");
const managedState = require("../src/services/profiles/managedState");
const { createFakeAdapter } = require("../src/services/session/processMonitor");

async function installMod(duty, dataDir, name, files) {
  const payload = tmpDir(`pkg-${name}-`);
  const staging = tmpDir(`stg-${name}-`);
  for (const [rel, content] of Object.entries(files)) writeFile(payload, rel, String(content));
  const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
  const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
  return { manifest, payload, staging };
}

// ---- Personal knowledge layer + priority ---------------------------------

test("user knowledge override, priority order, and clearing", () => {
  const dataDir = tmpDir("uk-");
  const entry = userKnowledge.setEntry(dataDir, "install-1", {
    displayName: "My Stop The Ped",
    notes: "Works great on duty",
    homepage: "https://example.com",
    aliases: ["STP"],
  });
  assert.equal(entry.displayName, "My Stop The Ped");
  assert.ok(entry.updatedAt);

  const fetched = userKnowledge.getEntry(dataDir, { installId: "install-1" });
  assert.equal(fetched.notes, "Works great on duty");

  // Priority: user override wins over local-verified and built-in.
  const resolved = userKnowledge.resolveField("displayName", {
    user: { displayName: "USER NAME" },
    localVerified: { displayName: "LOCAL NAME" },
    builtIn: { displayName: "BUILTIN NAME" },
  });
  assert.equal(resolved.value, "USER NAME");
  assert.equal(resolved.source, "USER_OVERRIDE");
  assert.equal(resolved.userProvided, true);

  const fallback = userKnowledge.resolveField("displayName", {
    localVerified: { displayName: "LOCAL NAME" },
    builtIn: { displayName: "BUILTIN NAME" },
  });
  assert.equal(fallback.value, "LOCAL NAME");
  assert.equal(fallback.source, "LOCAL_VERIFIED_DATA");
  assert.equal(fallback.userProvided, false);

  const unknown = userKnowledge.resolveField("displayName", {});
  assert.equal(unknown.source, "UNKNOWN");

  const view = userKnowledge.resolveMod({
    mod: { installId: "install-1", name: "Stop The Ped", version: "1.9" },
    userEntry: userKnowledge.getEntry(dataDir, { installId: "install-1" }),
    builtIn: { name: "Stop The Ped", category: "GAMEPLAY", authors: ["Author"] },
  });
  assert.equal(view.displayName, "My Stop The Ped");
  assert.equal(view.provenance.displayName.userProvided, true);
  assert.equal(view.hasUserOverride, true);

  // Alternate key: canonicalModId survives a reinstall with a new installId.
  userKnowledge.setEntry(dataDir, "stp-canonical", { knownGoodVersion: "1.8.5" });
  const byCanonical = userKnowledge.getEntry(dataDir, { installId: "new-install", canonicalModId: "stp-canonical" });
  assert.equal(byCanonical.knownGoodVersion, "1.8.5");

  // Clearing a field.
  userKnowledge.setEntry(dataDir, "install-1", { notes: "" });
  assert.equal(userKnowledge.getEntry(dataDir, { installId: "install-1" }).notes, undefined);

  cleanup(dataDir);
});

test("known-good mod version is separate metadata", () => {
  const dataDir = tmpDir("kg-");
  userKnowledge.markKnownGoodVersion(dataDir, "stp", "1.8.5");
  const entry = userKnowledge.getEntry(dataDir, { installId: "stp" });
  assert.equal(entry.knownGoodVersion, "1.8.5");
  cleanup(dataDir);
});

// ---- Update intelligence -------------------------------------------------

test("update risk scoring is deterministic and never uses version number alone", () => {
  assert.equal(updateIntelligence.scoreUpdateRisk({ parkedFrameworkRequired: true }).level, "HIGH");
  assert.equal(updateIntelligence.scoreUpdateRisk({ compatibilityWarning: true }).level, "HIGH");
  assert.equal(updateIntelligence.scoreUpdateRisk({ crashRegressionHistory: true }).level, "HIGH");
  assert.equal(updateIntelligence.scoreUpdateRisk({ compatibilityUnknown: true }).level, "MEDIUM");
  assert.equal(updateIntelligence.scoreUpdateRisk({ dependencyChanges: true }).level, "MEDIUM");
  assert.equal(
    updateIntelligence.scoreUpdateRisk({
      compatibilitySameOrVerified: true,
      dependenciesSame: true,
      configsPreserved: true,
      noProtectedFiles: true,
    }).level,
    "LOW"
  );
  assert.equal(updateIntelligence.scoreUpdateRisk({}).level, "UNKNOWN");
});

test("detectUpdate summarizes an installed-vs-dropped package", () => {
  const detected = updateIntelligence.detectUpdate({
    installed: { id: "stp", version: "1.8.0" },
    preview: {
      droppedVersion: "1.9.0",
      duplicate: { relation: "UPDATE" },
      counts: { add: 1, replace: 3, skip: 2 },
      updateReview: { added: ["a"], replaced: ["b", "c", "d"], removed: [], configsPreserved: ["x.ini"] },
      compatibility: { status: "UNKNOWN" },
      installSafety: { findings: [] },
      resolvedDependencies: [],
      dependencySummary: { requiredTotal: 1 },
    },
    userEntry: { knownGoodVersion: "1.8.0" },
    sessions: [],
  });
  assert.equal(detected.installedVersion, "1.8.0");
  assert.equal(detected.droppedVersion, "1.9.0");
  assert.equal(detected.knownGoodVersion, "1.8.0");
  assert.equal(detected.changes.filesReplaced, 3);
  assert.equal(detected.changes.compatibility, "UNKNOWN");
  assert.equal(detected.risk.level, "MEDIUM");
});

test("version history shows only stored versions; known-good rollback is transactional", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("vh-");
  const snapshotRoot = tmpDir("vh-snaps-");
  const online = tmpDir("vh-online-");
  const installed = await installMod(duty, dataDir, "StopThePed", { "plugins/LSPDFR/StopThePed.dll": "stp-1.7-bytes" });

  // Pin the manifest to a concrete version before the snapshot captures it.
  manifestStore.write(dataDir, { ...manifestStore.read(dataDir, installed.manifest.id), version: "1.7" });
  const ctx = { dataDir, dutyPath: duty, snapshotRoot, officialPath: online, processAdapter: createFakeAdapter() };
  snapshotManager.create(ctx, { name: "STP 1.7" });

  // Update to 1.9 on disk + mark 1.7 as known-good.
  manifestStore.write(dataDir, { ...manifestStore.read(dataDir, installed.manifest.id), version: "1.9" });
  writeFile(duty, "plugins/LSPDFR/StopThePed.dll", "stp-1.9-bytes");
  userKnowledge.markKnownGoodVersion(dataDir, installed.manifest.id, "1.7");

  const history = updateIntelligence.versionHistory(ctx, installed.manifest.id);
  assert.ok(history.some((row) => row.version === "1.9" && row.current));
  assert.ok(history.some((row) => row.version === "1.7" && row.knownGood && row.hasPayload));

  const plan = updateIntelligence.planKnownGoodRestore(ctx, installed.manifest.id);
  assert.equal(plan.available, true);
  assert.equal(plan.to, "1.7");

  const result = await updateIntelligence.restoreKnownGoodVersion(ctx, installed.manifest.id);
  assert.equal(fs.readFileSync(path.join(duty, "plugins", "LSPDFR", "StopThePed.dll"), "utf8"), "stp-1.7-bytes");
  assert.equal(manifestStore.read(dataDir, installed.manifest.id).version, "1.7");
  assert.notEqual(result.preHash, result.postHash);

  cleanup(duty, dataDir, snapshotRoot, online, installed.payload, installed.staging);
});

test("known-good rollback refuses when the payload is gone (no fake restore)", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("kgp-");
  const snapshotRoot = tmpDir("kgp-snaps-");
  const installed = await installMod(duty, dataDir, "Missing", { "plugins/LSPDFR/Missing.dll": "bytes" });
  userKnowledge.markKnownGoodVersion(dataDir, installed.manifest.id, "9.9.9");
  const ctx = { dataDir, dutyPath: duty, snapshotRoot, officialPath: tmpDir("kgp-online-") };
  const plan = updateIntelligence.planKnownGoodRestore(ctx, installed.manifest.id);
  assert.equal(plan.available, false);
  assert.equal(plan.reason, "PACKAGE_UNAVAILABLE");
  cleanup(duty, dataDir, snapshotRoot, ctx.officialPath, installed.payload, installed.staging);
});

// ---- Mod Health V2 -------------------------------------------------------

test("mod health is unified and always explains itself", () => {
  const sessions = [
    { result: "CLEAN_EXIT", mods: [{ installId: "m", enabled: true }] },
    { result: "RPH_CRASH", mods: [{ installId: "m", enabled: true }] },
    { result: "RPH_CRASH", mods: [{ installId: "m", enabled: true }] },
  ];
  const profiles = [{ name: "Stable Patrol", mods: [{ installId: "m" }] }];

  const disabled = modHealthV2.evaluateModHealth({ id: "m", enabled: false }, { sessions, profiles });
  assert.equal(disabled.status, "DISABLED");
  assert.ok(disabled.reasons.length);

  const broken = modHealthV2.evaluateModHealth({ id: "m", enabled: true, manifestStatus: "MANIFEST_ERROR" }, {});
  assert.equal(broken.status, "BROKEN");
  assert.match(broken.reasons[0], /manifest/i);

  const warn = modHealthV2.evaluateModHealth(
    { id: "m", enabled: true, compatibilityStatus: "UNKNOWN", files: [{ destination: "plugins/LSPDFR/M.dll" }] },
    { sessions, profiles }
  );
  assert.equal(warn.status, "WARNING");
  assert.ok(warn.reasons.some((r) => /waiting for runtime/i.test(r)));
  assert.deepEqual(warn.profiles, ["Stable Patrol"]);
  assert.equal(warn.crash.failed, 2);
  assert.equal(warn.crash.clean, 1);

  const healthy = modHealthV2.evaluateModHealth({ id: "h", enabled: true, compatibilityStatus: "VERIFIED" }, { sessions: [], profiles: [] });
  assert.equal(healthy.status, "HEALTHY");
  assert.ok(healthy.reasons.length);
});

test("crash correlation levels are conservative", () => {
  const enabled = (result) => ({ result, mods: [{ installId: "m", enabled: true }] });
  assert.equal(modHealthV2.crashCorrelation("m", [enabled("CLEAN_EXIT")]).level, "NONE");
  assert.equal(modHealthV2.crashCorrelation("m", [enabled("CLEAN_EXIT"), enabled("RPH_CRASH")]).level, "MEDIUM");
  assert.equal(
    modHealthV2.crashCorrelation("m", [enabled("RPH_CRASH"), enabled("RPH_CRASH"), enabled("RPH_CRASH")]).level,
    "HIGH"
  );
});

// ---- Dependency graph / impact / orphans ---------------------------------

function depDatabase() {
  return {
    mods: [
      { id: "example-callouts", name: "Example Callouts", dependencies: [{ componentId: "lemonui", kind: "REQUIRED" }] },
      { id: "another", name: "Another Plugin", dependencies: [{ componentId: "lemonui", kind: "REQUIRED" }] },
      { id: "lemonui", name: "LemonUI", dependencies: [] },
      { id: "ifruit", name: "iFruitAddon2", dependencies: [] },
      { id: "uses-ifruit", name: "Uses iFruit", dependencies: [{ componentId: "ifruit", kind: "REQUIRED" }] },
    ],
  };
}

test("dependency impact lists dependents before a disable", () => {
  const mods = [
    { id: "example-callouts", canonicalModId: "example-callouts", name: "Example Callouts", enabled: true },
    { id: "another", canonicalModId: "another", name: "Another Plugin", enabled: true },
    { id: "lemonui", canonicalModId: "lemonui", name: "LemonUI", enabled: true },
  ];
  const graph = dependencyGraph.build({ mods, database: depDatabase() });
  const impact = dependencyGraph.impactOfDisabling(graph, "lemonui").map((row) => row.name).sort();
  assert.deepEqual(impact, ["Another Plugin", "Example Callouts"]);
  assert.equal(dependencyGraph.requiredDependents(graph, "lemonui").length, 2);

  const tree = dependencyGraph.forwardTree(graph, "example-callouts");
  assert.equal(tree.dependencies[0].name, "LemonUI");
  assert.equal(tree.dependencies[0].installed, true);
});

test("orphan detection flags a dependency nothing installed requires", () => {
  const mods = [
    { id: "example-callouts", canonicalModId: "example-callouts", name: "Example Callouts", enabled: true },
    { id: "lemonui", canonicalModId: "lemonui", name: "LemonUI", enabled: true },
    { id: "ifruit", canonicalModId: "ifruit", name: "iFruitAddon2", enabled: true },
  ];
  const graph = dependencyGraph.build({ mods, database: depDatabase() });
  const orphans = dependencyGraph.orphans(graph).map((row) => row.name);
  assert.deepEqual(orphans, ["iFruitAddon2"]);
});

// ---- Dashboard priority alerts + Duty Health V2 --------------------------

test("Duty health summarizes with explicit reasons and priority alerts", () => {
  const context = {
    tests: { blocking: 1, warnings: 2, checks: [{ ok: false, level: "bad", title: "GTA V Enhanced", detail: "missing exe" }] },
    modHealth: [
      { installId: "b", status: "BROKEN", reasons: ["Managed files are missing."] },
      { installId: "w", status: "WARNING", reasons: ["Compatibility with this Duty setup is unknown."] },
    ],
    profile: { profile: { name: "Testing" }, drift: { drifted: true, notes: ["Example Callouts enabled"] } },
    overlays: { nvidiaOverlay: true },
    missingRequiredDeps: [{ name: "LemonUI" }],
  };
  const summary = dutyHealthV2.summarize(context);
  assert.equal(summary.status, "BROKEN");
  assert.ok(summary.reasons.length > 0);

  const alerts = dutyHealthV2.priorityAlerts({ ...context, staleAnalysisCount: 1 });
  assert.equal(alerts[0].kind, "LAUNCH_BLOCKING");
  const kinds = alerts.map((a) => a.kind);
  assert.ok(kinds.includes("BROKEN_MOD"));
  assert.ok(kinds.includes("MISSING_REQUIRED_DEPENDENCY"));
  assert.ok(kinds.includes("PROFILE_DRIFT"));
  assert.ok(kinds.includes("STALE_CRASH_ANALYSIS"));
  assert.ok(kinds.includes("UNKNOWN_COMPATIBILITY"));
  // Sorted by priority ascending.
  for (let i = 1; i < alerts.length; i += 1) assert.ok(alerts[i].priority >= alerts[i - 1].priority);
});

test("healthy Duty summarizes as HEALTHY", () => {
  const summary = dutyHealthV2.summarize({ tests: { blocking: 0, warnings: 0, checks: [] }, modHealth: [{ status: "HEALTHY" }], profile: { drift: { drifted: false } }, overlays: {} });
  assert.equal(summary.status, "HEALTHY");
});

// ---- Smart Install readiness + risky snapshot policy ---------------------

test("Smart Install readiness only flips on a clean local track record", () => {
  assert.equal(smartReadiness.evaluate({ successfulInstalls: 12, rollbackFailures: 0, analysisErrors: 0 }).ready, true);
  assert.equal(smartReadiness.evaluate({ successfulInstalls: 5, rollbackFailures: 0 }).ready, false);
  assert.equal(smartReadiness.evaluate({ successfulInstalls: 20, rollbackFailures: 1 }).ready, false);
  assert.equal(smartReadiness.evaluate({ successfulInstalls: 10, rollbackFailures: 0, analysisErrors: 5 }).ready, false);
});

test("snapshot-before-risky-install defaults on for HIGH risk", () => {
  assert.equal(smartReadiness.shouldSnapshotBeforeInstall({ risk: "HIGH", settings: {} }), true);
  assert.equal(smartReadiness.shouldSnapshotBeforeInstall({ risk: "LOW", settings: {} }), false);
  assert.equal(smartReadiness.shouldSnapshotBeforeInstall({ risk: "HIGH", settings: { snapshotBeforeRiskyInstall: false } }), false);
  assert.equal(smartReadiness.shouldSnapshotBeforeInstall({ risk: "LOW", presetId: "TESTING_INSTALL" }), true);
});

// ---- Profile recommendation ----------------------------------------------

test("profile recommendation suggests known-good after enough clean sessions", () => {
  const profile = { profileId: "p1", name: "Testing", knownGood: false };
  const sessions = Array.from({ length: 5 }, () => ({ profileId: "p1", result: "CLEAN_EXIT" }));
  const rec = profileRecommendation.recommend(profile, sessions);
  assert.equal(rec.suggest, true);
  assert.match(rec.message, /known-good/i);

  const already = profileRecommendation.recommend({ ...profile, knownGood: true }, sessions);
  assert.equal(already.suggest, false);

  const notEnough = profileRecommendation.recommend(profile, sessions.slice(0, 2));
  assert.equal(notEnough.suggest, false);
});

// ---- Session filters -----------------------------------------------------

test("session filters split by result, profile, and mod", () => {
  const sessions = [
    { sessionId: "a", result: "CLEAN_EXIT", profileId: "p1", mods: [{ installId: "m", enabled: true }] },
    { sessionId: "b", result: "RPH_CRASH", profileId: "p2", mods: [{ installId: "n", enabled: true }] },
    { sessionId: "c", result: "UNKNOWN", profileId: "p1", mods: [] },
    { sessionId: "d", result: null, incomplete: true, mods: [] },
  ];
  assert.equal(filterSessions(sessions, { type: "All" }).length, 4);
  assert.equal(filterSessions(sessions, { type: "Clean" }).length, 1);
  assert.equal(filterSessions(sessions, { type: "Crash" }).length, 1);
  assert.equal(filterSessions(sessions, { type: "Unknown" }).length, 2);
  assert.equal(filterSessions(sessions, { type: "Profile", profileId: "p1" }).length, 2);
  assert.equal(filterSessions(sessions, { type: "Mod", installId: "m" }).length, 1);
});

// ---- Global search + filters ---------------------------------------------

test("mod search matches name, dll, alias, and category; filters by status", () => {
  const mods = [
    { id: "1", name: "Stop The Ped", canonicalModId: "stp", category: "GAMEPLAY", enabled: true, files: [{ destination: "plugins/LSPDFR/StopThePed.dll" }] },
    { id: "2", name: "LemonUI", canonicalModId: "lemonui", category: "LIBRARY", enabled: false, files: [{ destination: "LemonUI.dll" }] },
  ];
  const knowledgeById = new Map([["lemonui", { name: "LemonUI", aliases: ["Lemon"], recognition: { dllNames: ["LemonUI.dll"] } }]]);
  const context = { knowledgeById, userKnowledgeById: new Map(), profiles: [] };
  assert.equal(modSearch.search(mods, "stoptheped", context)[0].id, "1");
  assert.equal(modSearch.search(mods, "lemon", context)[0].id, "2");
  assert.equal(modSearch.search(mods, "GAMEPLAY", context)[0].id, "1");
  assert.equal(modSearch.filter(mods, { statuses: ["DISABLED"] }, context).length, 1);
  assert.equal(modSearch.filter(mods, { category: "library" }, context)[0].id, "2");
});

// ---- Diagnostic report redaction -----------------------------------------

test("diagnostic report redacts user, home, and secrets", () => {
  const report = buildReport(
    {
      appVersion: "1.0.0",
      mods: [{ name: "Mod", version: "1.0", enabled: true }],
      logs: [{ name: "RagePluginHook.log", excerpt: "C:\\Users\\liam\\Documents opened. token=ABCDEF123 at /home/liam/gta" }],
    },
    { home: "C:\\Users\\liam", username: "liam" }
  );
  const text = JSON.stringify(report);
  assert.ok(!/\bliam\b/.test(text), "username should be redacted");
  assert.ok(!text.includes("ABCDEF123"), "secret should be redacted");
  assert.ok(text.includes("<USER>") || text.includes("<HOME>"));
  assert.ok(text.includes("<REDACTED>"));

  // Direct redact of bearer tokens.
  assert.match(redact("Authorization: Bearer abc.def.ghi"), /<REDACTED>/);
});

// ---- Storage cleanup safety ----------------------------------------------

test("storage cleanup never removes protected recovery data", () => {
  const snapshotRoot = tmpDir("sc-snaps-");
  const dataDir = tmpDir("sc-data-");
  const stagingRoot = tmpDir("sc-staging-");
  const actionRoot = tmpDir("sc-actions-");

  // 20 plain automatic snapshots (retention keeps 15) + pinned + known-good.
  for (let i = 0; i < 20; i += 1) {
    snapshotStore.writeSnapshot(snapshotRoot, {
      snapshotId: `auto-${String(i).padStart(2, "0")}`,
      name: `Auto ${i}`,
      reason: "BEFORE_UPDATE",
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      mods: [],
      configs: [],
    });
  }
  snapshotStore.writeSnapshot(snapshotRoot, { snapshotId: "pinned-1", name: "Pinned", reason: "BEFORE_UPDATE", pinned: true, createdAt: "2026-01-02T00:00:00.000Z", mods: [], configs: [] });
  snapshotStore.writeSnapshot(snapshotRoot, { snapshotId: "kg-1", name: "Known Good", reason: "MANUAL", knownGood: true, createdAt: "2026-01-03T00:00:00.000Z", mods: [], configs: [] });

  // Active payload + pending crash action must be protected.
  manifestStore.write(dataDir, { id: "m1", name: "Mod", version: "1", files: [], schemaVersion: 1 });
  fs.mkdirSync(path.join(dataDir, "store", "m1"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "store", "m1", "keep.bin"), "payload");
  fs.writeFileSync(path.join(dataDir, "leftover.tmp"), "junk");
  fs.mkdirSync(path.join(stagingRoot, "abandoned"), { recursive: true });
  fs.writeFileSync(path.join(stagingRoot, "abandoned", "f.txt"), "x");
  fs.writeFileSync(path.join(actionRoot, "action-1.json"), "{}");

  const ctx = { snapshotRoot, dataDir, stagingRoot, actionRoot };
  const plan = storageManager.planCleanup(ctx);
  assert.ok(plan.protected.includes("snapshot:pinned-1"));
  assert.ok(plan.protected.includes("snapshot:kg-1"));
  assert.ok(plan.protected.includes("payload:m1"));
  assert.ok(plan.protected.includes("crash-action:action-1.json"));
  assert.ok(plan.candidates.some((c) => c.kind === "ABANDONED_STAGING"));
  assert.ok(plan.candidates.some((c) => c.kind === "STALE_TEMP"));
  assert.ok(plan.candidates.some((c) => c.kind === "OLD_AUTOMATIC_SNAPSHOT"));

  // Attempt to remove EVERYTHING including protected ids.
  const allIds = plan.candidates.map((c) => c.id).concat(["snapshot:pinned-1", "snapshot:kg-1", "payload:m1"]);
  storageManager.applyCleanup(ctx, allIds);

  assert.ok(snapshotStore.getSnapshot(snapshotRoot, "pinned-1"), "pinned snapshot must survive");
  assert.ok(snapshotStore.getSnapshot(snapshotRoot, "kg-1"), "known-good snapshot must survive");
  assert.ok(fs.existsSync(path.join(dataDir, "store", "m1", "keep.bin")), "active payload must survive");
  assert.ok(fs.existsSync(path.join(actionRoot, "action-1.json")), "pending crash action must survive");
  assert.ok(!fs.existsSync(path.join(dataDir, "leftover.tmp")), "temp file should be cleaned");
  assert.ok(!fs.existsSync(path.join(stagingRoot, "abandoned")), "staging should be cleaned");

  cleanup(snapshotRoot, dataDir, stagingRoot, actionRoot);
});

// ---- Manager backup export / import --------------------------------------

test("manager backup exports and re-imports manager-owned metadata only", () => {
  const profileRoot = tmpDir("bk-profiles-");
  const snapshotRoot = tmpDir("bk-snaps-");
  const dataDir = tmpDir("bk-data-");
  const userData = tmpDir("bk-userdata-");

  profileStore.writeProfile(profileRoot, { profileId: "p1", name: "Stable Patrol", mods: [], configs: [] });
  snapshotStore.writeSnapshot(snapshotRoot, { snapshotId: "s1", name: "Point", reason: "MANUAL", mods: [], configs: [] });
  userKnowledge.setEntry(dataDir, "k1", { notes: "keep me" });
  manifestStore.write(dataDir, { id: "m1", name: "Mod", version: "1", files: [], schemaVersion: 1 });
  bumpMetric(dataDir, "successfulInstalls");
  appendAudit(dataDir, "INSTALL_COMMITTED", { installId: "m1" });
  config.save(userData, { developerMode: true });

  const source = { profileRoot, snapshotRoot, dataDir, userData, appVersion: "1.0.0" };
  const dest = tmpDir("bk-dest-");
  const manifest = managerBackup.exportBackup(source, dest);
  assert.equal(manifest.schemaVersion, 1);
  const kinds = manifest.contents.map((c) => c.kind);
  assert.ok(["profiles", "snapshots", "mod-knowledge", "manifests", "history", "settings"].every((k) => kinds.includes(k)));

  const check = managerBackup.readBackup(dest);
  assert.equal(check.valid, true);

  // Restore into fresh, empty targets.
  const target = { profileRoot: tmpDir("bk-p2-"), snapshotRoot: tmpDir("bk-s2-"), dataDir: tmpDir("bk-d2-"), userData: tmpDir("bk-u2-") };
  const plan = managerBackup.planImport(dest, target);
  assert.equal(plan.valid, true);
  assert.ok(plan.steps.length >= 4);

  managerBackup.applyImport(dest, target);
  assert.ok(profileStore.getProfile(target.profileRoot, "p1"));
  assert.equal(userKnowledge.getEntry(target.dataDir, { installId: "k1" }).notes, "keep me");
  assert.ok(manifestStore.read(target.dataDir, "m1"));
  assert.equal(config.load(target.userData).developerMode, true);

  cleanup(profileRoot, snapshotRoot, dataDir, userData, dest, target.profileRoot, target.snapshotRoot, target.dataDir, target.userData);
});

test("manager backup rejects a malformed backup folder", () => {
  const dir = tmpDir("bad-backup-");
  fs.writeFileSync(path.join(dir, "backup.json"), "{not json");
  assert.equal(managerBackup.readBackup(dir).valid, false);
  assert.equal(managerBackup.planImport(dir, {}).valid, false);
  cleanup(dir);
});

// ---- Self-diagnostic ------------------------------------------------------

test("self-diagnostic validates manager-owned state and keeps app health separate", () => {
  const userData = tmpDir("sd-user-");
  const dataDir = tmpDir("sd-data-");
  const profileRoot = tmpDir("sd-profiles-");
  const snapshotRoot = tmpDir("sd-snaps-");
  const sessionRoot = tmpDir("sd-sessions-");
  manifestStore.write(dataDir, { id: "m1", name: "Mod", version: "1", files: [], schemaVersion: 1 });

  const result = selfCheck.run({ userData, dataDir, profileRoot, snapshotRoot, sessionRoot });
  assert.equal(result.appHealth, "HEALTHY");
  assert.ok(result.checks.find((c) => c.id === "userdata-writable").ok);
  assert.ok(result.checks.find((c) => c.id === "manifests-readable").ok);
  assert.ok(result.checks.find((c) => c.id === "payload-references").ok);

  cleanup(userData, dataDir, profileRoot, snapshotRoot, sessionRoot);
});

// ---- Config intelligence --------------------------------------------------

test("config intelligence describes drift and restores the stored default", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("ci-");
  const installed = await installMod(duty, dataDir, "StopThePed", {
    "plugins/LSPDFR/StopThePed.dll": "dll",
    "plugins/LSPDFR/StopThePed.ini": "Volume=1\n",
  });
  const mod = smartInstall.list(dataDir, duty).find((row) => row.id === installed.manifest.id);

  writeFile(duty, "plugins/LSPDFR/StopThePed.ini", "Volume=99\n");
  const described = configIntelligence.describeManagedConfigs(mod, { dutyPath: duty, dataDir });
  const iniRow = described.find((row) => /StopThePed\.ini$/.test(row.destination));
  assert.ok(iniRow);
  assert.equal(iniRow.modifiedFromDefault, true);
  assert.equal(iniRow.canRestoreDefault, true);

  const diff = configIntelligence.diffAgainstDefault(mod, "plugins/LSPDFR/StopThePed.ini", { dutyPath: duty, dataDir });
  assert.equal(diff.diff.changed, true);

  configIntelligence.restoreDefault({ dutyPath: duty, dataDir }, installed.manifest.id, "plugins/LSPDFR/StopThePed.ini");
  assert.equal(fs.readFileSync(path.join(duty, "plugins", "LSPDFR", "StopThePed.ini"), "utf8"), "Volume=1\n");

  cleanup(duty, dataDir, installed.payload, installed.staging);
});

// ---- Troubleshooting flow -------------------------------------------------

test("troubleshoot suggests known-good recovery when the crash cause is unknown", () => {
  const result = troubleshoot.run({
    tests: { verdict: "ready", blocking: 0, warnings: 0, checks: [] },
    profile: { profile: { name: "Testing" }, drift: { drifted: false } },
    modHealth: [],
    missingRequiredDeps: [],
    lastCrashAnalysis: { analysisConfidence: "UNKNOWN", suspects: [] },
  });
  assert.equal(result.suggestion.action, "RESTORE_KNOWN_GOOD");
  assert.ok(result.steps.length >= 5);
});

test("log viewer lists Duty and manager logs only and tails safely", () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("logs-data-");
  writeFile(duty, "RagePluginHook.log", "line1\nsecret token=ABCDEF\nline3\n");
  writeFile(dataDir, "smart-audit.jsonl", '{"event":"INSTALL_COMMITTED"}\n');
  const logViewer = require("../src/services/diagnostics/logViewer");
  const listed = logViewer.listLogs({ dutyPath: duty, dataDir });
  assert.ok(listed.some((row) => row.kind === "RPH"));
  assert.ok(listed.some((row) => row.kind === "MANAGER"));
  const read = logViewer.readLog(listed.find((row) => row.kind === "RPH").path, { search: "token" });
  assert.match(read.text, /token=/);
  cleanup(duty, dataDir);
});

test("troubleshoot puts launch-blocking issues first", () => {
  const result = troubleshoot.run({
    tests: { verdict: "blocked", blocking: 1, warnings: 0, checks: [{ ok: false, level: "bad", title: "GTA V Enhanced", detail: "missing exe" }] },
    profile: null,
    modHealth: [],
    missingRequiredDeps: [],
    lastCrashAnalysis: null,
  });
  assert.equal(result.suggestion.action, "RUN_HEALTH");
});
