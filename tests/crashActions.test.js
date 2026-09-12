const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeFile, makeFakeDuty, cleanup } = require("./helpers");
const { createSessionManager } = require("../src/services/session/sessionManager");
const { createFakeAdapter } = require("../src/services/session/processMonitor");
const smartInstall = require("../src/services/smartInstall");
const crashActions = require("../src/services/crash/crashActions");
const actionStore = require("../src/services/crash/crashActionStore");
const { classifyRetest, requiredRetestMs } = require("../src/services/crash/retestClassifier");
const view = require("../src/services/crash/crashActionView");
const { ACTION_TYPES, ACTION_STATES, RETEST_OUTCOMES } = require("../src/services/crash/crashActionTypes");

function session(id, extra = {}) {
  return {
    sessionId: id,
    startedAt: extra.startedAt || "2026-01-01T12:00:00.000Z",
    endedAt: extra.endedAt || "2026-01-01T12:03:12.000Z",
    durationMs: extra.durationMs == null ? 192000 : extra.durationMs,
    state: extra.state || "CRASHED",
    result: extra.result || "RPH_CRASH",
    environment: { gtaVersion: "1.0", rphVersion: "1.110", lspdfrVersion: "0.4.9", ...(extra.environment || {}) },
    mods: extra.mods || [{ installId: "stp", name: "Stop The Ped", version: "1.8.0", enabled: true }],
    recentChanges: extra.recentChanges || [{ installId: "stp", event: "UPDATED", at: "2026-01-01T11:00:00.000Z" }],
    overlays: extra.overlays || { atLaunch: { nvidiaOverlay: true }, nvidiaDetected: true },
    dependencies: extra.dependencies || [],
  };
}

function analysis(extra = {}) {
  return {
    sessionId: extra.sessionId || "crash-1",
    analysisConfidence: extra.analysisConfidence || "HIGH",
    stale: extra.stale === true,
    status: extra.status || "CURRENT",
    suspects: extra.suspects || [
      { type: "MOD", installId: "stp", name: "Stop The Ped", score: 80, confidence: "HIGH", reasons: ["Named exception"] },
    ],
    evidence: {
      fingerprint: extra.fingerprint || "fp-1",
      versionChanges: extra.versionChanges || [{ installId: "stp", name: "Stop The Ped", from: "1.7.0", to: "1.8.0" }],
    },
  };
}

function ctx(extra = {}) {
  const calls = extra.calls || { enabled: [] };
  return crashActions.createContext({
    actionRoot: extra.actionRoot || tmpDir("actions-"),
    sessionRoot: extra.sessionRoot,
    dataDir: extra.dataDir || tmpDir("data-"),
    dutyPath: extra.dutyPath,
    session: extra.session || session("crash-1"),
    analysis: extra.analysis || analysis(),
    inventory: extra.inventory || [
      { id: "stp", installId: "stp", name: "Stop The Ped", version: "1.8.0", enabled: true, files: [{ destination: "plugins/LSPDFR/StopThePed.dll", action: "add" }] },
    ],
    persist: extra.persist,
    previousSources: extra.previousSources,
    adapters: extra.adapters || {
      setEnabled: async ({ modId, enabled }) => {
        calls.enabled.push({ modId, enabled });
      },
      repair: ({ modId }) => {
        calls.repaired = calls.repaired || [];
        calls.repaired.push(modId);
      },
      rollback: async () => {
        calls.rolled = (calls.rolled || 0) + 1;
      },
      restoreRollback: async () => {
        calls.restoredRollback = true;
      },
      closeOverlay: () => {
        calls.overlay = true;
      },
      rollbackPreview: () => extra.rollbackPreview || { from: "1.8.0", to: "1.7.0", configPolicy: "Keep existing", filesReplaced: 8, filesRestored: 2 },
    },
    now: () => "2026-01-01T13:00:00.000Z",
    ...extra.ctx,
  });
}

test("plan disable action is read-only and does not change mods", () => {
  const calls = { enabled: [] };
  const context = ctx({ persist: false, adapters: { setEnabled: async (row) => calls.enabled.push(row) } });
  const plans = crashActions.planForSession(context);
  const disable = plans.find((row) => row.type === ACTION_TYPES.DISABLE_MOD_AND_RETEST);
  assert.ok(disable);
  assert.equal(disable.reversible, true);
  assert.equal(disable.execute, false);
  assert.deepEqual(disable.changes, ["Disable Stop The Ped"]);
  assert.equal(calls.enabled.length, 0);
});

test("stale analysis blocks action planning and apply", async () => {
  const actionRoot = tmpDir("stale-actions-");
  const context = ctx({
    actionRoot,
    analysis: analysis({ stale: true }),
  });
  const plans = crashActions.planForSession(context);
  assert.ok(plans.every((row) => row.available === false));
  assert.equal(view.actionAvailable(plans[0], { stale: true }), false);
  assert.match(view.STALE_COPY, /Re-analyze before applying a test/);
  await assert.rejects(() => crashActions.applyAction(context, plans[0].actionId), /out of date/i);
  cleanup(actionRoot, context.dataDir);
});

test("disable uses existing managed path", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  const payload = tmpDir("payload-");
  const actionRoot = tmpDir("actions-");
  writeFile(payload, "plugins/LSPDFR/StopThePed.dll", "STP");
  const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
  const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
  const context = ctx({
    actionRoot,
    dataDir,
    dutyPath: duty,
    inventory: smartInstall.list(dataDir, duty),
    session: session("crash-1", { mods: [{ installId: manifest.id, name: manifest.name, version: manifest.version, enabled: true }] }),
    analysis: analysis({ suspects: [{ type: "MOD", installId: manifest.id, name: manifest.name, score: 80, confidence: "HIGH" }], versionChanges: [] }),
    adapters: {},
  });
  const plans = crashActions.planForSession(context);
  const disable = plans.find((row) => row.type === ACTION_TYPES.DISABLE_MOD_AND_RETEST);
  const applied = await crashActions.applyAction(context, disable.actionId);
  assert.equal(applied.state, ACTION_STATES.APPLIED);
  assert.equal(smartInstall.list(dataDir, duty)[0].enabled, false);
  assert.equal(fs.existsSync(path.join(duty, "plugins", "LSPDFR", "StopThePed.dll")), false);
  cleanup(duty, dataDir, staging, payload, actionRoot);
});

test("rollback version plan shows preview and is available when payload exists", () => {
  const context = ctx({ persist: false, previousSources: { stp: "C:\\old\\ub" } });
  const plans = crashActions.planForSession(context);
  const rollback = plans.find((row) => row.type === ACTION_TYPES.ROLLBACK_MOD_AND_RETEST);
  assert.ok(rollback);
  assert.equal(rollback.preview.from, "1.8.0");
  assert.equal(rollback.preview.to, "1.7.0");
  assert.equal(rollback.available, true);
});

test("repair plan is offered only for missing managed files", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/StopThePed.dll", "STP");
  const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
  const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
  fs.rmSync(path.join(duty, "plugins", "LSPDFR", "StopThePed.dll"), { force: true });
  const context = ctx({
    persist: false,
    dataDir,
    dutyPath: duty,
    inventory: smartInstall.list(dataDir, duty),
    analysis: analysis({ suspects: [{ type: "MOD", installId: manifest.id, name: manifest.name, score: 80, confidence: "HIGH" }], versionChanges: [] }),
    adapters: {},
  });
  const plans = crashActions.planForSession(context);
  assert.ok(plans.some((row) => row.type === ACTION_TYPES.REPAIR_MOD_AND_RETEST));
  cleanup(duty, dataDir, staging, payload);
});

test("overlay retest plan uses existing suppression and does not change mods", async () => {
  const calls = { enabled: [] };
  const actionRoot = tmpDir("ov-actions-");
  const context = ctx({
    actionRoot,
    analysis: analysis({
      suspects: [{ type: "OVERLAY", name: "NVIDIA Overlay", score: 52, confidence: "MEDIUM" }],
      versionChanges: [],
    }),
    adapters: {
      setEnabled: async (row) => calls.enabled.push(row),
      closeOverlay: () => {
        calls.overlay = true;
      },
    },
  });
  const plans = crashActions.planForSession(context);
  const overlay = plans.find((row) => row.type === ACTION_TYPES.CLOSE_OVERLAY_AND_RETEST);
  assert.ok(overlay);
  const applied = await crashActions.applyAction(context, overlay.actionId);
  assert.equal(applied.state, ACTION_STATES.APPLIED);
  assert.equal(calls.overlay, true);
  assert.equal(calls.enabled.length, 0);
  cleanup(actionRoot, context.dataDir);
});

test("action persistence and restore", async () => {
  const actionRoot = tmpDir("persist-actions-");
  const calls = { enabled: [] };
  const context = ctx({
    actionRoot,
    adapters: {
      setEnabled: async (row) => calls.enabled.push(row),
      rollbackPreview: () => null,
    },
    analysis: analysis({ versionChanges: [] }),
  });
  const plans = crashActions.planForSession(context);
  const disable = plans.find((row) => row.type === ACTION_TYPES.DISABLE_MOD_AND_RETEST);
  assert.equal(actionStore.getAction(actionRoot, disable.actionId).state, ACTION_STATES.PLANNED);
  await crashActions.applyAction(context, disable.actionId);
  assert.equal(actionStore.getAction(actionRoot, disable.actionId).state, ACTION_STATES.APPLIED);
  await crashActions.restoreAction(context, disable.actionId);
  assert.equal(actionStore.getAction(actionRoot, disable.actionId).state, ACTION_STATES.RESTORED);
  assert.deepEqual(calls.enabled, [
    { modId: "stp", enabled: false },
    { modId: "stp", enabled: true },
  ]);
  cleanup(actionRoot, context.dataDir);
});

test("retest session linking and result classification", () => {
  const actionRoot = tmpDir("link-actions-");
  const context = ctx({ actionRoot, persist: true, analysis: analysis({ versionChanges: [] }) });
  const plans = crashActions.planForSession(context);
  const disable = plans.find((row) => row.type === ACTION_TYPES.DISABLE_MOD_AND_RETEST);
  const linked = crashActions.markRetestLaunched(context, disable.actionId, "retest-9");
  assert.equal(linked.retestSessionId, "retest-9");
  assert.equal(linked.state, ACTION_STATES.RETEST_LAUNCHED);
  const completed = crashActions.completeRetest(context, {
    sessionId: "retest-9",
    crashActionId: disable.actionId,
    result: "CLEAN_EXIT",
    durationMs: 28 * 60 * 1000,
  });
  assert.equal(completed.retest.outcome, RETEST_OUTCOMES.NO_CRASH_OBSERVED);
  assert.equal(completed.retest.evidenceType, "RETEST_NO_CRASH");
  cleanup(actionRoot, context.dataDir);
});

test("crash reproduced and launch failed stay conservative", () => {
  assert.equal(classifyRetest({ durationMs: 180000 }, { result: "RPH_CRASH", durationMs: 20000 }).outcome, RETEST_OUTCOMES.CRASH_REPRODUCED);
  assert.equal(classifyRetest({ durationMs: 180000 }, { result: "LAUNCH_FAILED", durationMs: 0 }).outcome, RETEST_OUTCOMES.LAUNCH_FAILED);
});

test("short retest duration is not treated as success", () => {
  const short = classifyRetest({ durationMs: 192000 }, { result: "CLEAN_EXIT", durationMs: 5000 });
  assert.equal(short.outcome, RETEST_OUTCOMES.UNKNOWN);
  assert.ok(requiredRetestMs(192000) > 5000);
  const long = classifyRetest({ durationMs: 192000 }, { result: "CLEAN_EXIT", durationMs: 28 * 60 * 1000 });
  assert.equal(long.outcome, RETEST_OUTCOMES.NO_CRASH_OBSERVED);
});

test("manager restart recovery keeps applied snapshot", async () => {
  const actionRoot = tmpDir("rec-actions-");
  const context = ctx({ actionRoot, analysis: analysis({ versionChanges: [] }) });
  const plans = crashActions.planForSession(context);
  const disable = plans.find((row) => row.type === ACTION_TYPES.DISABLE_MOD_AND_RETEST);
  await crashActions.applyAction(context, disable.actionId);
  const recovery = crashActions.recoveryState(actionRoot);
  assert.equal(recovery.status, "APPLIED_AWAITING_LAUNCH");
  assert.ok(recovery.action.snapshot);
  assert.equal(crashActions.pendingForLaunch(actionRoot).actionId, disable.actionId);
  cleanup(actionRoot, context.dataDir);
});

test("failed action rolls back enablement", async () => {
  const actionRoot = tmpDir("fail-actions-");
  const calls = { enabled: [] };
  const context = ctx({
    actionRoot,
    analysis: analysis({ versionChanges: [] }),
    adapters: {
      setEnabled: async (row) => {
        calls.enabled.push(row);
        if (row.enabled === false) throw new Error("Park failed");
      },
    },
  });
  const plans = crashActions.planForSession(context);
  const disable = plans.find((row) => row.type === ACTION_TYPES.DISABLE_MOD_AND_RETEST);
  await assert.rejects(() => crashActions.applyAction(context, disable.actionId), /Park failed/);
  assert.equal(actionStore.getAction(actionRoot, disable.actionId).state, ACTION_STATES.FAILED);
  assert.ok(calls.enabled.some((row) => row.enabled === true), "restore should re-enable after failure");
  cleanup(actionRoot, context.dataDir);
});

test("session beginLaunch records retest link fields", () => {
  const root = tmpDir("sess-");
  const duty = makeFakeDuty();
  const sessions = createSessionManager({ root, adapter: createFakeAdapter(), disableMonitor: true, skipWindows: true });
  const created = sessions.beginLaunch({
    dutyPath: duty,
    dataDir: tmpDir("d-"),
    retestOfSessionId: "crash-1",
    crashActionId: "action-1",
  });
  assert.equal(created.retestOfSessionId, "crash-1");
  assert.equal(created.crashActionId, "action-1");
  cleanup(root, duty);
});

test("UI view states: available, unavailable, stale, pending, success, reproduced", () => {
  const disable = { type: ACTION_TYPES.DISABLE_MOD_AND_RETEST, available: true, targetName: "Stop The Ped", changes: ["Disable Stop The Ped"] };
  assert.equal(view.actionAvailable(disable, { stale: false }), true);
  assert.equal(view.actionAvailable(disable, { stale: true }), false);
  assert.equal(view.actionAvailable({ type: ACTION_TYPES.NO_SAFE_ACTION }, {}), false);
  const confirm = view.confirmationCopy(disable);
  assert.match(confirm.body, /No files will be deleted/);
  const banner = view.pendingBanner({ ...disable, sessionId: "crash-1", state: ACTION_STATES.APPLIED }, { startedAt: "2026-09-14T08:42:00.000Z" });
  assert.equal(banner.title, "Retest mode");
  const success = view.retestResultCopy(
    { ...disable, retest: { outcome: RETEST_OUTCOMES.NO_CRASH_OBSERVED, durationMs: 28 * 60 * 1000 }, snapshot: { originalDurationMs: 192000 } },
    { durationMs: 192000 },
    { durationMs: 28 * 60 * 1000 }
  );
  assert.match(success.body, /does not prove causation/);
  const reproduced = view.retestResultCopy({ ...disable, retest: { outcome: RETEST_OUTCOMES.CRASH_REPRODUCED } });
  assert.match(reproduced.body, /weakens/);
});

test("rollback apply uses adapter and restore uses snapshot path", async () => {
  const actionRoot = tmpDir("rb-actions-");
  const calls = {};
  const context = ctx({
    actionRoot,
    previousSources: { stp: "old" },
    adapters: {
      setEnabled: async () => {},
      rollback: async () => {
        calls.rolled = true;
      },
      restoreRollback: async () => {
        calls.restored = true;
      },
      rollbackPreview: () => ({ from: "1.8.0", to: "1.7.0", configPolicy: "Keep existing", filesReplaced: 8, filesRestored: 2 }),
    },
  });
  const plans = crashActions.planForSession(context);
  const rollback = plans.find((row) => row.type === ACTION_TYPES.ROLLBACK_MOD_AND_RETEST);
  await crashActions.applyAction(context, rollback.actionId);
  assert.equal(calls.rolled, true);
  await crashActions.restoreAction(context, rollback.actionId);
  assert.equal(calls.restored, true);
  cleanup(actionRoot, context.dataDir);
});
