const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeFile, makeFakeDuty, cleanup } = require("./helpers");
const smartInstall = require("../src/services/smartInstall");
const manifestStore = require("../src/services/manifestStore");
const profileManager = require("../src/services/profiles/profileManager");
const profileStore = require("../src/services/profiles/profileStore");
const managedState = require("../src/services/profiles/managedState");
const { HEALTH, CODES, SCHEMA_VERSION } = require("../src/services/profiles/profileTypes");
const snapshotManager = require("../src/services/snapshots/snapshotManager");
const snapshotStore = require("../src/services/snapshots/snapshotStore");
const { REASONS, RETENTION, SCHEMA_VERSION: SNAP_SCHEMA } = require("../src/services/snapshots/snapshotTypes");
const { createSessionManager } = require("../src/services/session/sessionManager");
const { createFakeAdapter } = require("../src/services/session/processMonitor");
const { analyzeSession } = require("../src/services/crash/crashAnalyzer");
const { appendAudit } = require("../src/services/smartAudit");

function idleAdapter() {
  return createFakeAdapter();
}

function runningAdapter() {
  return createFakeAdapter([{ image: "GTA5_Enhanced.exe", pid: 42, running: true }]);
}

function ctx(duty, dataDir, extras = {}) {
  return {
    profileRoot: extras.profileRoot || tmpDir("profiles-"),
    snapshotRoot: extras.snapshotRoot || tmpDir("snaps-"),
    dataDir,
    dutyPath: extras.dutyPath != null ? extras.dutyPath : duty,
    officialPath: extras.officialPath != null ? extras.officialPath : tmpDir("online-"),
    processAdapter: extras.processAdapter || idleAdapter(),
    payloadRoot: extras.payloadRoot,
    payloadLookup: extras.payloadLookup,
    adapters: extras.adapters,
    ...extras.more,
  };
}

async function installMod(duty, dataDir, name, files) {
  const payload = tmpDir(`pkg-${name}-`);
  const staging = tmpDir(`stg-${name}-`);
  for (const [rel, content] of Object.entries(files)) writeFile(payload, rel, String(content));
  const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
  const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
  return { manifest, payload, staging };
}

async function installNamed(duty, dataDir, name) {
  return installMod(duty, dataDir, name, { [`plugins/LSPDFR/${name}.dll`]: `${name}-bytes` });
}

function hashNow(dataDir, duty) {
  return managedState.stateHash(managedState.captureManagedState({ dataDir, dutyPath: duty }));
}

function auditText(dataDir) {
  const file = path.join(dataDir, "smart-audit.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

test("profile create, from current state, rename, duplicate, delete, activate", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("pdata-");
  const extras = [];
  const first = await installNamed(duty, dataDir, "AlphaCallouts");
  extras.push(first.payload, first.staging);
  const context = ctx(duty, dataDir);
  const created = profileManager.createFromCurrent(context, { name: "Stable Patrol" });
  assert.equal(created.schemaVersion, SCHEMA_VERSION);
  assert.equal(created.name, "Stable Patrol");
  assert.equal(created.mods.length, 1);
  assert.equal(created.mods[0].installId, first.manifest.id);
  assert.equal(created.mods[0].enabled, true);
  assert.equal(profileStore.loadIndex(context.profileRoot).activeProfileId, created.profileId);

  const renamed = profileManager.rename(context, created.profileId, "Night Shift");
  assert.equal(renamed.name, "Night Shift");

  const copy = profileManager.duplicate(context, created.profileId, "Testing");
  assert.notEqual(copy.profileId, created.profileId);
  assert.equal(copy.name, "Testing");
  assert.equal(copy.knownGood, false);
  assert.equal(copy.mods[0].installId, first.manifest.id);

  const second = await installNamed(duty, dataDir, "BravoBackup");
  extras.push(second.payload, second.staging);
  const other = profileManager.createFromCurrent(context, { name: "Current messy" });
  assert.notEqual(profileStore.loadIndex(context.profileRoot).activeProfileId, other.profileId);

  await profileManager.switchProfile(context, other.profileId);
  assert.equal(profileStore.loadIndex(context.profileRoot).activeProfileId, other.profileId);

  profileManager.remove(context, copy.profileId);
  profileManager.remove(context, other.profileId);
  assert.equal(profileStore.getProfile(context.profileRoot, other.profileId), null);
  assert.throws(() => profileManager.remove(context, created.profileId), /at least one profile/i);

  cleanup(duty, dataDir, context.profileRoot, context.snapshotRoot, context.officialPath, ...extras);
});

test("migration imports Current Setup without changing Duty files", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("mig-data-");
  const installed = await installNamed(duty, dataDir, "MigratedMod");
  const before = hashNow(dataDir, duty);
  const beforeFiles = fs.readdirSync(path.join(duty, "plugins", "LSPDFR")).sort();
  const context = ctx(duty, dataDir);
  const migrated = profileManager.migrateIfNeeded(context);
  assert.equal(migrated.name, "Current Setup");
  assert.equal(migrated.mods[0].installId, installed.manifest.id);
  assert.equal(hashNow(dataDir, duty), before);
  assert.deepEqual(fs.readdirSync(path.join(duty, "plugins", "LSPDFR")).sort(), beforeFiles);
  const names = profileStore.listProfiles(context.profileRoot).map((row) => row.name);
  assert.ok(!names.includes("Stable Patrol"));
  assert.ok(!names.includes("Testing"));
  const again = profileManager.migrateIfNeeded(context);
  assert.equal(again.profileId, migrated.profileId);
  cleanup(duty, dataDir, context.profileRoot, context.snapshotRoot, context.officialPath, installed.payload, installed.staging);
});

test("switch plan, success, missing mod, missing version payload, and external config drift", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("sw-data-");
  const a = await installNamed(duty, dataDir, "CalloutPack");
  const b = await installMod(duty, dataDir, "StopThePed", {
    "plugins/LSPDFR/StopThePed.dll": "stp-1.7",
    "plugins/LSPDFR/StopThePed.ini": "Volume=1\n",
  });
  const context = ctx(duty, dataDir);
  const stable = profileManager.createFromCurrent(context, { name: "Stable Patrol" });
  await smartInstall.setEnabled({ modId: a.manifest.id, dutyPath: duty, dataDir, enabled: false });
  const testing = profileManager.createFromCurrent(context, { name: "Testing" });

  const plan = profileManager.planSwitch(context, stable.profileId);
  assert.match(profileManager.describePlan(plan), /SWITCH TO: STABLE PATROL/);
  assert.equal(plan.enable.some((row) => row.installId === a.manifest.id), true);
  assert.equal(plan.complete, true);

  const switched = await profileManager.switchProfile(context, stable.profileId);
  assert.equal(smartInstall.list(dataDir, duty).find((mod) => mod.id === a.manifest.id).enabled, true);
  assert.equal(profileStore.loadIndex(context.profileRoot).activeProfileId, stable.profileId);
  assert.match(auditText(dataDir), /PROFILE_SWITCH_COMPLETED/);
  assert.ok(switched.postHash);

  const missingId = "gone-install";
  stable.mods.push({
    installId: missingId,
    canonicalModId: "gone",
    name: "Vanished Callouts",
    version: "1.0",
    enabled: true,
  });
  profileStore.writeProfile(context.profileRoot, stable);
  const afterMissing = profileStore.getProfile(context.profileRoot, stable.profileId);
  assert.ok(afterMissing.mods.some((mod) => mod.installId === missingId));
  const missingPlan = profileManager.planSwitch(context, stable.profileId);
  assert.equal(missingPlan.complete, false);
  assert.match(missingPlan.incompleteMessage, /PROFILE INCOMPLETE/);
  await assert.rejects(() => profileManager.switchProfile(context, stable.profileId), (error) => {
    assert.equal(error.code, CODES.PROFILE_INCOMPLETE);
    return true;
  });
  assert.ok(profileStore.getProfile(context.profileRoot, stable.profileId).mods.some((mod) => mod.installId === missingId));

  const clean = profileStore.getProfile(context.profileRoot, testing.profileId);
  clean.mods = clean.mods.map((mod) =>
    mod.installId === b.manifest.id ? { ...mod, version: "1.7" } : mod
  );
  profileStore.writeProfile(context.profileRoot, clean);
  const manifest = manifestStore.read(dataDir, b.manifest.id);
  manifest.version = "1.8";
  manifestStore.write(dataDir, manifest);
  const versionPlan = profileManager.planSwitch(context, clean.profileId);
  assert.equal(versionPlan.complete, false);
  assert.match(versionPlan.incomplete[0].message, /1\.7 is required but the package is no longer available/);

  const withIni = profileManager.createFromCurrent(context, { name: "Config Base" });
  const iniRel = "plugins/LSPDFR/StopThePed.ini";
  writeFile(duty, iniRel, "Volume=99\n");
  const driftPlan = profileManager.planSwitch(context, withIni.profileId);
  assert.ok(driftPlan.externalConfigs.some((row) => row.destination === iniRel));
  await assert.rejects(() => profileManager.switchProfile(context, withIni.profileId), /CONFIG CHANGED OUTSIDE MOD MANAGER/);
  await profileManager.switchProfile(context, withIni.profileId, { confirmOverwriteConfigs: true });
  assert.equal(fs.readFileSync(path.join(duty, "plugins", "LSPDFR", "StopThePed.ini"), "utf8"), "Volume=1\n");

  cleanup(
    duty,
    dataDir,
    context.profileRoot,
    context.snapshotRoot,
    context.officialPath,
    a.payload,
    a.staging,
    b.payload,
    b.staging
  );
});

test("profile health, drift, known good, and session evidence", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("hlth-");
  const installed = await installNamed(duty, dataDir, "HealthMod");
  const context = ctx(duty, dataDir);
  const profile = profileManager.createFromCurrent(context, { name: "Stable Patrol" });
  profile.mods = profile.mods.map((mod) => ({ ...mod, compatibility: "LIKELY" }));
  profileStore.writeProfile(context.profileRoot, profile);
  const current = managedState.captureManagedState({ dataDir, dutyPath: duty });
  assert.equal(profileManager.healthOf(profile, current, () => true), HEALTH.HEALTHY);

  profile.mods[0].compatibility = "UNKNOWN";
  assert.equal(profileManager.healthOf(profile, current, () => true), HEALTH.WARNING);
  profile.mods[0].compatibility = "LIKELY";
  profile.drifted = true;
  assert.equal(profileManager.healthOf(profile, current, () => true), HEALTH.WARNING);
  assert.equal(profileManager.healthOf({ corrupt: true }, current, () => true), HEALTH.BROKEN);

  const incomplete = { ...profile, drifted: false, mods: [...profile.mods, { installId: "missing", name: "Ghost", version: "1", enabled: true }] };
  assert.equal(profileManager.healthOf(incomplete, current, () => false), HEALTH.INCOMPLETE);

  await smartInstall.setEnabled({ modId: installed.manifest.id, dutyPath: duty, dataDir, enabled: false });
  const live = managedState.captureManagedState({ dataDir, dutyPath: duty });
  const drift = profileManager.driftAgainst(profileStore.getProfile(context.profileRoot, profile.profileId), live);
  assert.equal(drift.drifted, true);
  assert.ok(drift.notes.some((note) => /disabled/i.test(note)));
  const marked = profileManager.markDrifted(context, drift.notes);
  assert.equal(marked.drifted, true);
  const stored = profileStore.getProfile(context.profileRoot, profile.profileId);
  assert.equal(stored.drifted, true);
  assert.equal(stored.mods[0].enabled, true);

  const extra = await installNamed(duty, dataDir, "NewCallouts");
  const afterInstall = managedState.captureManagedState({ dataDir, dutyPath: duty });
  const installDrift = profileManager.driftAgainst(stored, afterInstall);
  assert.ok(installDrift.notes.some((note) => /NewCallouts|enabled/i.test(note)));
  assert.equal(
    profileStore.getProfile(context.profileRoot, profile.profileId).mods.some((mod) => mod.installId === extra.manifest.id),
    false
  );

  profileManager.updateProfileFromCurrent(context, profile.profileId);
  const updated = profileStore.getProfile(context.profileRoot, profile.profileId);
  assert.equal(updated.drifted, false);
  assert.ok(updated.mods.some((mod) => mod.installId === extra.manifest.id));

  const known = profileManager.markKnownGood(context, profile.profileId);
  assert.equal(known.knownGood, true);
  assert.equal(profileStore.loadIndex(context.profileRoot).knownGoodProfileId, profile.profileId);
  const second = profileManager.createFromCurrent(context, { name: "Testing" });
  profileManager.markKnownGood(context, second.profileId);
  assert.equal(profileStore.getProfile(context.profileRoot, profile.profileId).knownGood, false);
  assert.equal(profileStore.getProfile(context.profileRoot, second.profileId).knownGood, true);

  const evidence = profileManager.knownGoodEvidence([
    { result: "CLEAN_EXIT", durationMs: 3600000 },
    { result: "CLEAN_EXIT", durationMs: 7920000 },
    { result: "CLEAN_EXIT", durationMs: 1800000 },
    { result: "CLEAN_EXIT", durationMs: 2400000 },
    { result: "CLEAN_EXIT", durationMs: 600000 },
    { result: "CLEAN_EXIT", durationMs: 1200000 },
  ]);
  assert.equal(evidence.cleanSessions, 6);
  assert.equal(evidence.totalStableMs, 17520000);
  assert.equal(evidence.noCrashesInLast5, true);
  const summary = profileManager.compatibilitySummary(updated, smartInstall.list(dataDir, duty));
  assert.equal(summary.mods, updated.mods.length);

  cleanup(
    duty,
    dataDir,
    context.profileRoot,
    context.snapshotRoot,
    context.officialPath,
    installed.payload,
    installed.staging,
    extra.payload,
    extra.staging
  );
});

test("manual snapshot, automatic snapshot, pin, retention, restore plan and success", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("snap-data-");
  const installed = await installNamed(duty, dataDir, "SnapMod");
  const context = ctx(duty, dataDir);
  const manual = snapshotManager.create(context, { name: "Known Good Before Testing New Callouts" });
  assert.equal(manual.schemaVersion, SNAP_SCHEMA);
  assert.equal(manual.reason, REASONS.MANUAL);
  assert.equal(manual.name, "Known Good Before Testing New Callouts");
  assert.equal(manual.mods[0].installId, installed.manifest.id);

  const auto = snapshotManager.create(context, { reason: REASONS.BEFORE_UPDATE });
  assert.equal(auto.reason, REASONS.BEFORE_UPDATE);
  assert.match(auto.name, /update/i);

  await smartInstall.setEnabled({ modId: installed.manifest.id, dutyPath: duty, dataDir, enabled: false });
  const preview = snapshotManager.planRestore(context, manual.snapshotId);
  assert.equal(preview.plan.enable.length, 1);
  assert.match(snapshotManager.describePlan(preview.plan, preview.snapshot), /RESTORE SNAPSHOT/);

  const restored = await snapshotManager.restore(context, manual.snapshotId);
  assert.equal(smartInstall.list(dataDir, duty)[0].enabled, true);
  assert.equal(restored.preHash !== restored.postHash, true);
  assert.match(auditText(dataDir), /SNAPSHOT_RESTORED/);

  const pinned = snapshotManager.pin(context, auto.snapshotId, true);
  assert.equal(pinned.pinned, true);
  for (let i = 0; i < RETENTION.MANUAL + 3; i += 1) {
    snapshotManager.create(context, { name: `Manual ${i}`, reason: REASONS.MANUAL });
  }
  const manuals = snapshotStore.listSnapshots(context.snapshotRoot).filter((row) => row.reason === REASONS.MANUAL && !row.pinned);
  assert.ok(manuals.length <= RETENTION.MANUAL);
  assert.ok(snapshotStore.getSnapshot(context.snapshotRoot, auto.snapshotId));

  for (let i = 0; i < RETENTION.AUTOMATIC + 4; i += 1) {
    snapshotManager.create(context, { reason: REASONS.BEFORE_REPAIR, name: `Auto ${i}` });
  }
  const autos = snapshotStore
    .listSnapshots(context.snapshotRoot)
    .filter((row) => row.reason !== REASONS.MANUAL && !row.pinned && !row.knownGood);
  assert.ok(autos.length <= RETENTION.AUTOMATIC);
  assert.ok(snapshotStore.getSnapshot(context.snapshotRoot, auto.snapshotId).pinned);

  const usage = snapshotManager.storageUsage(context.profileRoot, context.snapshotRoot);
  assert.ok(usage.snapshotsBytes > 0);

  cleanup(duty, dataDir, context.profileRoot, context.snapshotRoot, context.officialPath, installed.payload, installed.staging);
});

test("snapshot environment change warns but does not mark unusable", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("env-");
  const installed = await installNamed(duty, dataDir, "EnvMod");
  const context = ctx(duty, dataDir);
  const snap = snapshotManager.create(context, { name: "Old world" });
  snap.environment = { gtaVersion: "1.0", rphVersion: "1.95", lspdfrVersion: "0.4.8" };
  snapshotStore.writeSnapshot(context.snapshotRoot, snap);
  const preview = snapshotManager.planRestore(context, snap.snapshotId);
  assert.ok(preview.plan.environmentWarning);
  assert.equal(preview.plan.environmentWarning.title, "ENVIRONMENT CHANGED");
  assert.match(preview.plan.environmentWarning.snapshot, /GTA 1\.0/);
  assert.equal(preview.plan.complete, true);
  cleanup(duty, dataDir, context.profileRoot, context.snapshotRoot, context.officialPath, installed.payload, installed.staging);
});

test("version restore works when a snapshot payload exists", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("ver-");
  const installed = await installMod(duty, dataDir, "StopThePed", {
    "plugins/LSPDFR/StopThePed.dll": "stp-1.7-bytes",
  });
  const context = ctx(duty, dataDir);
  const snap = snapshotManager.create(context, { name: "STP 1.7" });
  const manifest = manifestStore.read(dataDir, installed.manifest.id);
  manifest.version = "1.8";
  manifestStore.write(dataDir, manifest);
  writeFile(duty, "plugins/LSPDFR/StopThePed.dll", "stp-1.8-bytes");
  const preview = snapshotManager.planRestore(context, snap.snapshotId);
  assert.equal(preview.plan.complete, true);
  assert.equal(preview.plan.restoreVersion[0].to, snap.mods[0].version);
  await snapshotManager.restore(context, snap.snapshotId);
  assert.equal(fs.readFileSync(path.join(duty, "plugins", "LSPDFR", "StopThePed.dll"), "utf8"), "stp-1.7-bytes");
  cleanup(duty, dataDir, context.profileRoot, context.snapshotRoot, context.officialPath, installed.payload, installed.staging);
});

test("game-running guard and Online rejection", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("guard-");
  const installed = await installNamed(duty, dataDir, "GuardMod");
  const online = ctx(duty, dataDir, { officialPath: duty });
  assert.throws(() => profileManager.createFromCurrent(online, { name: "Nope" }), (error) => {
    assert.equal(error.code, CODES.ONLINE_TARGET_REJECTED);
    return true;
  });
  assert.throws(() => snapshotManager.create(online, { name: "Nope" }), (error) => {
    assert.equal(error.code, CODES.ONLINE_TARGET_REJECTED);
    return true;
  });

  const empty = tmpDir("not-enhanced-");
  const rejected = ctx(empty, dataDir, { dutyPath: empty, officialPath: tmpDir("online2-") });
  assert.throws(() => managedState.assertDutyTarget(rejected), (error) => {
    assert.equal(error.code, CODES.ONLINE_TARGET_REJECTED);
    return true;
  });

  const context = ctx(duty, dataDir, { processAdapter: runningAdapter() });
  const profile = profileManager.createFromCurrent(context, { name: "Busy" });
  const snap = snapshotManager.create({ ...context, processAdapter: idleAdapter() }, { name: "Hold" });
  await assert.rejects(() => profileManager.switchProfile(context, profile.profileId), (error) => {
    assert.equal(error.code, CODES.GAME_RUNNING);
    assert.match(error.message, /will not close it/i);
    return true;
  });
  await assert.rejects(() => snapshotManager.restore(context, snap.snapshotId), (error) => {
    assert.equal(error.code, CODES.GAME_RUNNING);
    return true;
  });

  cleanup(duty, dataDir, empty, context.profileRoot, context.snapshotRoot, context.officialPath, rejected.officialPath, online.profileRoot, online.snapshotRoot, installed.payload, installed.staging);
});

test("session records profile and snapshot; crash analyzer treats profile evidence as correlation", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("sess-");
  const root = tmpDir("sess-root-");
  const sessions = createSessionManager({ root, adapter: idleAdapter(), disableMonitor: true, skipWindows: true });
  const created = sessions.beginLaunch({
    dutyPath: duty,
    dataDir,
    profileId: "testing-profile",
    snapshotId: "snap-1",
  });
  assert.equal(created.profileId, "testing-profile");
  assert.equal(created.snapshotId, "snap-1");

  const crashed = (id, profileId) => ({
    sessionId: id,
    startedAt: "2026-01-01T12:00:00.000Z",
    endedAt: "2026-01-01T12:01:00.000Z",
    durationMs: 60000,
    state: "CRASHED",
    result: "RPH_CRASH",
    profileId,
    environment: { gtaVersion: "1.0", rphVersion: "1.110", lspdfrVersion: "0.4.9" },
    mods: [{ installId: "stp", name: "Stop The Ped", version: "1.8", enabled: true }],
    recentChanges: [],
    processes: { atLaunch: [] },
    overlays: { atLaunch: {}, nvidiaDetected: false },
    logs: [],
    copiedLogs: [],
    logText: "",
    dependencies: [],
    timeline: [],
  });
  const clean = (id, profileId) => ({ ...crashed(id, profileId), state: "COMPLETED", result: "CLEAN_EXIT" });
  const analysis = analyzeSession("now", {
    persist: false,
    session: crashed("now", "testing-profile"),
    history: [crashed("old-fail", "testing-profile"), clean("ok-1", "stable-profile"), clean("ok-2", "stable-profile")],
    now: () => "2026-01-01T13:00:00.000Z",
  });
  const hit = (analysis.suspects || []).find((row) => row.id === "profile:testing-profile");
  assert.ok(hit);
  assert.match(hit.reasons[0], /correlation, not proof/i);
  cleanup(duty, dataDir, root);
});

test("crash action and Smart Install mark drift without rewriting the profile", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("drift-");
  const installed = await installNamed(duty, dataDir, "DriftMod");
  const context = ctx(duty, dataDir);
  const profile = profileManager.createFromCurrent(context, { name: "Stable Patrol" });
  await smartInstall.setEnabled({ modId: installed.manifest.id, dutyPath: duty, dataDir, enabled: false });
  profileManager.markDrifted(context, ["Crash test: Disable DriftMod"]);
  const afterCrash = profileStore.getProfile(context.profileRoot, profile.profileId);
  assert.equal(afterCrash.drifted, true);
  assert.equal(afterCrash.mods[0].enabled, true);

  const extra = await installNamed(duty, dataDir, "FreshPack");
  profileManager.markDrifted(context, [`${extra.manifest.name} was installed or updated`]);
  const afterInstall = profileStore.getProfile(context.profileRoot, profile.profileId);
  assert.equal(afterInstall.mods.some((mod) => mod.installId === extra.manifest.id), false);
  assert.equal(afterInstall.drifted, true);
  cleanup(
    duty,
    dataDir,
    context.profileRoot,
    context.snapshotRoot,
    context.officialPath,
    installed.payload,
    installed.staging,
    extra.payload,
    extra.staging
  );
});

test("profile switch chaos: 15+ operations, fail around 8, hash matches pre-switch", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("chaos-p-");
  const packs = [];
  for (let i = 0; i < 16; i += 1) {
    packs.push(await installNamed(duty, dataDir, `ChaosP${i}`));
  }
  const context = ctx(duty, dataDir);
  const stable = profileManager.createFromCurrent(context, { name: "Stable Patrol" });
  for (const pack of packs) {
    await smartInstall.setEnabled({ modId: pack.manifest.id, dutyPath: duty, dataDir, enabled: false });
  }
  const plan = profileManager.planSwitch(context, stable.profileId);
  assert.ok(plan.ops.length >= 15, `expected >= 15 ops, got ${plan.ops.length}`);
  const before = hashNow(dataDir, duty);
  await assert.rejects(
    () => profileManager.switchProfile(context, stable.profileId, { hooks: { failAt: 8 } }),
    (error) => {
      assert.match(error.message, /Simulated failure at operation 8/);
      assert.equal(error.preHash, before);
      assert.equal(error.rolledBackHash, before);
      return true;
    }
  );
  assert.equal(hashNow(dataDir, duty), before);
  assert.equal(profileStore.loadIndex(context.profileRoot).activeProfileId, stable.profileId);
  assert.match(auditText(dataDir), /PROFILE_SWITCH_ROLLED_BACK/);
  for (const pack of packs) {
    assert.equal(smartInstall.list(dataDir, duty).find((mod) => mod.id === pack.manifest.id).enabled, false);
  }
  cleanup(
    duty,
    dataDir,
    context.profileRoot,
    context.snapshotRoot,
    context.officialPath,
    ...packs.flatMap((pack) => [pack.payload, pack.staging])
  );
});

test("snapshot restore chaos: 15+ changes, fail mid-restore, hash matches pre-restore", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("chaos-s-");
  const packs = [];
  for (let i = 0; i < 16; i += 1) {
    packs.push(await installNamed(duty, dataDir, `ChaosS${i}`));
  }
  const context = ctx(duty, dataDir);
  const snap = snapshotManager.create(context, { name: "Before experiment" });
  for (const pack of packs) {
    await smartInstall.setEnabled({ modId: pack.manifest.id, dutyPath: duty, dataDir, enabled: false });
  }
  const preview = snapshotManager.planRestore(context, snap.snapshotId);
  assert.ok(preview.plan.ops.length >= 15, `expected >= 15 ops, got ${preview.plan.ops.length}`);
  const before = hashNow(dataDir, duty);
  await assert.rejects(
    () => snapshotManager.restore(context, snap.snapshotId, { hooks: { failAt: 8 } }),
    (error) => {
      assert.match(error.message, /Simulated failure at operation 8/);
      assert.equal(error.preHash, before);
      assert.equal(error.rolledBackHash, before);
      return true;
    }
  );
  assert.equal(hashNow(dataDir, duty), before);
  assert.match(auditText(dataDir), /SNAPSHOT_RESTORE_ROLLED_BACK/);
  cleanup(
    duty,
    dataDir,
    context.profileRoot,
    context.snapshotRoot,
    context.officialPath,
    ...packs.flatMap((pack) => [pack.payload, pack.staging])
  );
});

test("audit events cover profile and snapshot lifecycle", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("aud-");
  const installed = await installNamed(duty, dataDir, "AuditMod");
  const context = ctx(duty, dataDir);
  const profile = profileManager.createFromCurrent(context, { name: "Audit" });
  profileManager.rename(context, profile.profileId, "Audit 2");
  profileManager.markKnownGood(context, profile.profileId);
  const snap = snapshotManager.create(context, { name: "Point" });
  snapshotManager.pin(context, snap.snapshotId, true);
  snapshotManager.remove(context, snap.snapshotId);
  const log = auditText(dataDir);
  for (const event of [
    "PROFILE_CREATED",
    "PROFILE_UPDATED",
    "PROFILE_MARKED_KNOWN_GOOD",
    "SNAPSHOT_CREATED",
    "SNAPSHOT_PINNED",
    "SNAPSHOT_DELETED",
  ]) {
    assert.match(log, new RegExp(event));
  }
  appendAudit(dataDir, "PROFILE_SWITCH_STARTED", { profileId: profile.profileId });
  cleanup(duty, dataDir, context.profileRoot, context.snapshotRoot, context.officialPath, installed.payload, installed.staging);
});
