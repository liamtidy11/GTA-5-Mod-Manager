const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const smartInstall = require("../smartInstall");
const manifestStore = require("../manifestStore");
const { diagnoseManagedMod } = require("../orphanDetector");
const { appendAudit } = require("../smartAudit");
const { freshness, getAnalysis } = require("./crashAnalyzer");
const { evidenceFingerprint } = require("./evidenceBuilder");
const {
  ACTION_TYPES,
  ACTION_STATES,
  ACTION_SCHEMA_VERSION,
  PENDING_STATES,
} = require("./crashActionTypes");
const store = require("./crashActionStore");
const { classifyRetest } = require("./retestClassifier");

function newId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `action-${Date.now().toString(36)}`;
}

function envFingerprint(session, inventory = []) {
  const env = (session && session.environment) || {};
  return {
    gtaVersion: env.gtaVersion || "UNKNOWN",
    rphVersion: env.rphVersion || "UNKNOWN",
    lspdfrVersion: env.lspdfrVersion || "UNKNOWN",
    mods: (inventory.length ? inventory : session.mods || []).map((mod) => ({
      installId: mod.id || mod.installId,
      version: mod.version || "UNKNOWN",
      enabled: mod.enabled !== false,
    })),
  };
}

function inventoryById(inventory) {
  const map = new Map();
  for (const mod of inventory || []) map.set(mod.id || mod.installId, mod);
  return map;
}

function staleGuard(ctx) {
  if (!ctx.analysis) return { ok: false, reason: "NO_ANALYSIS" };
  if (ctx.analysis.stale || ctx.analysis.status === "STALE") return { ok: false, reason: "STALE" };
  if (ctx.sessionRoot && ctx.session) {
    const fresh = freshness(ctx.sessionRoot, ctx.session.sessionId, ctx.session);
    if (fresh.status === "STALE") return { ok: false, reason: "STALE" };
  }
  const expected = envFingerprint(ctx.session);
  const current = envFingerprint(ctx.session, ctx.inventory);
  if (expected.gtaVersion !== current.gtaVersion || expected.rphVersion !== current.rphVersion || expected.lspdfrVersion !== current.lspdfrVersion) {
    return { ok: false, reason: "ENVIRONMENT_CHANGED" };
  }
  return { ok: true };
}

function targetStillMatches(plan, ctx) {
  if (!plan.installId) return { ok: true };
  const current = inventoryById(ctx.inventory).get(plan.installId);
  if (!current) return { ok: false, reason: "MOD_MISSING" };
  if (plan.expectedVersion && current.version && plan.expectedVersion !== current.version) {
    return { ok: false, reason: "VERSION_CHANGED" };
  }
  if (plan.expectedEnabled != null && Boolean(current.enabled) !== Boolean(plan.expectedEnabled)) {
    return { ok: false, reason: "STATE_CHANGED" };
  }
  return { ok: true };
}

function audit(ctx, event, action, extra = {}) {
  appendAudit(ctx.dataDir, event, {
    installId: action.installId || "",
    actionId: action.actionId,
    sessionId: action.sessionId,
    type: action.type,
    ...extra,
  });
}

function persist(ctx, action) {
  return store.writeAction(ctx.actionRoot, action);
}

function snapshotMods(ctx, installIds) {
  const ids = new Set(installIds || []);
  return (ctx.inventory || [])
    .filter((mod) => !ids.size || ids.has(mod.id || mod.installId))
    .map((mod) => ({
      installId: mod.id || mod.installId,
      name: mod.name,
      version: mod.version || "UNKNOWN",
      enabled: mod.enabled !== false,
      configPolicy: mod.configPolicy || "KEEP_EXISTING",
      files: (mod.files || []).map((file) => file.destination),
    }));
}

function makePlan(ctx, partial) {
  return {
    schemaVersion: ACTION_SCHEMA_VERSION,
    actionId: newId(),
    state: ACTION_STATES.PLANNED,
    sessionId: ctx.session.sessionId,
    analysisFingerprint: ctx.analysis.evidence && ctx.analysis.evidence.fingerprint,
    createdAt: ctx.now(),
    reversible: true,
    available: true,
    execute: false,
    confirmed: false,
    ...partial,
  };
}

function planForSession(ctx) {
  const fingerprint = ctx.analysis.evidence && ctx.analysis.evidence.fingerprint;
  if (ctx.persist !== false && ctx.actionRoot && fingerprint) {
    const existing = store
      .actionsForSession(ctx.actionRoot, ctx.session.sessionId)
      .filter((row) => row.state === ACTION_STATES.PLANNED && row.analysisFingerprint === fingerprint);
    if (existing.length) return existing;
  }
  const plans = [];
  const stale = staleGuard(ctx);
  const suspects = ctx.analysis.suspects || [];
  const mods = inventoryById(ctx.inventory);
  const versionChanges = (ctx.analysis.evidence && ctx.analysis.evidence.versionChanges) || [];

  for (const suspect of suspects) {
    if (suspect.type === "MOD" && suspect.installId && mods.has(suspect.installId)) {
      const mod = mods.get(suspect.installId);
      if (mod.enabled !== false) {
        plans.push(
          makePlan(ctx, {
            type: ACTION_TYPES.DISABLE_MOD_AND_RETEST,
            installId: suspect.installId,
            targetName: suspect.name || mod.name,
            expectedVersion: mod.version || "UNKNOWN",
            expectedEnabled: true,
            changes: [`Disable ${suspect.name || mod.name}`],
            primary: plans.every((row) => row.type !== ACTION_TYPES.DISABLE_MOD_AND_RETEST),
          })
        );
      }
      const change = versionChanges.find((row) => row.installId === suspect.installId);
      if (change) {
        const previousSource = ctx.previousSources && ctx.previousSources[suspect.installId];
        const preview = ctx.adapters && ctx.adapters.rollbackPreview && ctx.adapters.rollbackPreview(suspect.installId, change);
        plans.push(
          makePlan(ctx, {
            type: ACTION_TYPES.ROLLBACK_MOD_AND_RETEST,
            installId: suspect.installId,
            targetName: suspect.name || mod.name,
            expectedVersion: mod.version || change.to,
            expectedEnabled: mod.enabled !== false,
            available: Boolean(previousSource || preview),
            unavailableReason: previousSource || preview ? "" : "Previous version payload is not stored. Re-install the older archive through Smart Install to downgrade.",
            previousSource: previousSource || "",
            preview: preview || {
              from: change.to || mod.version,
              to: change.from,
              configPolicy: "Keep existing",
              filesReplaced: (mod.files || []).filter((file) => file.action === "replace").length,
              filesRestored: (mod.files || []).filter((file) => file.backup).length,
            },
            changes: [`Restore ${suspect.name || mod.name} from ${change.to || mod.version} to ${change.from}`],
          })
        );
      }
      if (ctx.dutyPath && canRepair(mod, ctx)) {
        plans.push(
          makePlan(ctx, {
            type: ACTION_TYPES.REPAIR_MOD_AND_RETEST,
            installId: suspect.installId,
            targetName: suspect.name || mod.name,
            expectedVersion: mod.version || "UNKNOWN",
            expectedEnabled: mod.enabled !== false,
            changes: [`Repair ${suspect.name || mod.name}`],
          })
        );
      }
    }

    if (suspect.type === "DEPENDENCY") {
      const dep = findDependency(ctx, suspect);
      if (dep && dep.required && (dep.status === "MISSING" || dep.present === false) && !dep.managed) {
        plans.push(
          makePlan(ctx, {
            type: ACTION_TYPES.OPEN_DEPENDENCY_DETAILS,
            targetName: suspect.name,
            reversible: false,
            changes: [`Open details for missing dependency ${suspect.name}`],
            note: "Use Smart Install to download curated official zips, or drop the pack yourself.",
          })
        );
      }
      if (dep && dep.managed && canRepair(mods.get(dep.installId || dep.id), ctx)) {
        plans.push(
          makePlan(ctx, {
            type: ACTION_TYPES.REPAIR_EXISTING_DEPENDENCY,
            installId: dep.installId || dep.id,
            targetName: suspect.name,
            expectedVersion: (mods.get(dep.installId || dep.id) || {}).version,
            expectedEnabled: true,
            changes: [`Repair managed dependency ${suspect.name}`],
          })
        );
      }
      if (dep && (dep.status === "DISABLED" || dep.enabled === false) && mods.has(dep.installId || dep.id)) {
        const parked = mods.get(dep.installId || dep.id);
        plans.push(
          makePlan(ctx, {
            type: ACTION_TYPES.RE_ENABLE_MOD,
            installId: parked.id || parked.installId,
            targetName: suspect.name || parked.name,
            expectedVersion: parked.version,
            expectedEnabled: false,
            strongerConfirmation: true,
            warning: "Required dependency is disabled.\n\nRe-enabling it may reintroduce a known local stability issue.",
            changes: [`Re-enable ${suspect.name || parked.name}`],
          })
        );
      }
    }

    if (suspect.type === "OVERLAY" || suspect.type === "GRAPHICS_HOOK") {
      plans.push(
        makePlan(ctx, {
          type: ACTION_TYPES.CLOSE_OVERLAY_AND_RETEST,
          targetName: suspect.name || "NVIDIA Overlay",
          changes: [`Close ${suspect.name || "NVIDIA Overlay"} for this launch`],
          overlay: true,
        })
      );
    }
  }

  const recentIds = recentlyChangedManaged(ctx, mods);
  if (recentIds.length) {
    plans.push(
      makePlan(ctx, {
        type: ACTION_TYPES.MINIMAL_RETEST,
        installIds: recentIds,
        targetName: "Recently changed mods",
        changes: [`Disable ${recentIds.length} recently changed managed mod(s)`],
      })
    );
  }

  if (!plans.length) {
    plans.push(
      makePlan(ctx, {
        type: ACTION_TYPES.NO_SAFE_ACTION,
        available: false,
        reversible: false,
        changes: ["No safe managed action is available for this analysis."],
      })
    );
  }

  if (!stale.ok) {
    for (const plan of plans) {
      plan.available = false;
      plan.stale = true;
      plan.unavailableReason = "STALE";
    }
  }

  const saved = [];
  if (ctx.persist !== false && ctx.actionRoot) {
    for (const plan of plans) saved.push(persist(ctx, plan));
    if (ctx.dataDir) {
      for (const plan of saved) audit(ctx, "CRASH_ACTION_PLANNED", plan);
    }
  }
  return ctx.persist === false ? plans : saved.length ? saved : plans;
}

function recentlyChangedManaged(ctx, mods) {
  const ids = new Set();
  for (const change of ctx.session.recentChanges || []) {
    const action = change.action || change.event || "";
    if (!/INSTALLED|UPDATED|DOWNGRADED|ENABLED|INSTALL_COMMITTED/.test(action)) continue;
    if (change.installId && mods.has(change.installId) && mods.get(change.installId).enabled !== false) {
      ids.add(change.installId);
    }
  }
  for (const row of (ctx.analysis.evidence && ctx.analysis.evidence.versionChanges) || []) {
    if (row.installId && mods.has(row.installId) && mods.get(row.installId).enabled !== false) ids.add(row.installId);
  }
  return [...ids];
}

function findDependency(ctx, suspect) {
  const rows = ctx.session.dependencies || [];
  return (
    rows.find((row) => row.id === suspect.id || row.name === suspect.name || row.installId === suspect.installId) || {
      name: suspect.name,
      required: true,
      status: /missing/i.test((suspect.reasons || []).join(" ")) ? "MISSING" : /disabled/i.test((suspect.reasons || []).join(" ")) ? "DISABLED" : "",
      managed: Boolean(suspect.installId && inventoryById(ctx.inventory).has(suspect.installId)),
      installId: suspect.installId,
      enabled: /disabled/i.test((suspect.reasons || []).join(" ")) ? false : true,
    }
  );
}

function canRepair(mod, ctx) {
  if (!mod || !ctx.dutyPath) return false;
  const diagnosis = diagnoseManagedMod(mod, { dutyPath: ctx.dutyPath, dataDir: ctx.dataDir });
  return diagnosis.status === "BROKEN" && diagnosis.issues.some((issue) => issue.code === "MISSING_MANAGED_FILE");
}

async function applyAction(ctx, actionId) {
  const action = store.getAction(ctx.actionRoot, actionId);
  if (!action) throw new Error("That crash action was not found.");
  const stale = staleGuard(ctx);
  if (!stale.ok) {
    action.available = false;
    action.stale = true;
    persist(ctx, action);
    const error = new Error("This crash analysis is out of date because the Duty setup changed.");
    error.code = "STALE";
    throw error;
  }
  const match = targetStillMatches(action, ctx);
  if (!match.ok) {
    const error = new Error("The Duty setup changed since this analysis. Re-analyze before applying a test.");
    error.code = match.reason;
    throw error;
  }
  if (action.type === ACTION_TYPES.OPEN_DEPENDENCY_DETAILS || action.type === ACTION_TYPES.NO_SAFE_ACTION) {
    return action;
  }
  if (!action.available) {
    const error = new Error(action.unavailableReason || "That test is not available.");
    error.code = "UNAVAILABLE";
    throw error;
  }

  action.state = ACTION_STATES.CONFIRMED;
  action.confirmedAt = ctx.now();
  action.snapshot = captureSnapshot(ctx, action);
  persist(ctx, action);

  try {
    await executeApply(ctx, action);
    action.state = ACTION_STATES.APPLIED;
    action.appliedAt = ctx.now();
    persist(ctx, action);
    audit(ctx, "CRASH_ACTION_APPLIED", action);
    return action;
  } catch (error) {
    action.state = ACTION_STATES.FAILED;
    action.error = error.message;
    persist(ctx, action);
    audit(ctx, "CRASH_ACTION_FAILED", action, { details: error.message });
    try {
      await executeRestore(ctx, action);
    } catch {
      /* existing transaction rollback already ran where possible */
    }
    throw error;
  }
}

function captureSnapshot(ctx, action) {
  const installIds = action.installIds || (action.installId ? [action.installId] : []);
  return {
    createdAt: ctx.now(),
    sessionId: ctx.session.sessionId,
    analysisFingerprint: (ctx.analysis.evidence && ctx.analysis.evidence.fingerprint) || evidenceFingerprint(ctx.session),
    originalDurationMs: ctx.session.durationMs || 0,
    originalResult: ctx.session.result,
    environment: envFingerprint(ctx.session, ctx.inventory),
    mods: snapshotMods(ctx, installIds),
    overlay: (ctx.session.overlays && ctx.session.overlays.atLaunch) || {},
  };
}

async function executeApply(ctx, action) {
  const adapters = ctx.adapters || {};
  if (action.type === ACTION_TYPES.DISABLE_MOD_AND_RETEST || action.type === ACTION_TYPES.MINIMAL_RETEST) {
    const ids = action.installIds || [action.installId];
    for (const id of ids) {
      if (adapters.setEnabled) await adapters.setEnabled({ modId: id, enabled: false });
      else await smartInstall.setEnabled({ modId: id, dutyPath: ctx.dutyPath, dataDir: ctx.dataDir, enabled: false });
    }
    return;
  }
  if (action.type === ACTION_TYPES.RE_ENABLE_MOD) {
    if (adapters.setEnabled) await adapters.setEnabled({ modId: action.installId, enabled: true });
    else await smartInstall.setEnabled({ modId: action.installId, dutyPath: ctx.dutyPath, dataDir: ctx.dataDir, enabled: true });
    return;
  }
  if (action.type === ACTION_TYPES.REPAIR_MOD_AND_RETEST || action.type === ACTION_TYPES.REPAIR_EXISTING_DEPENDENCY) {
    if (adapters.repair) adapters.repair({ modId: action.installId });
    else smartInstall.repair({ modId: action.installId, dutyPath: ctx.dutyPath, dataDir: ctx.dataDir });
    return;
  }
  if (action.type === ACTION_TYPES.ROLLBACK_MOD_AND_RETEST) {
    await applyRollback(ctx, action);
    return;
  }
  if (action.type === ACTION_TYPES.CLOSE_OVERLAY_AND_RETEST) {
    if (adapters.closeOverlay) adapters.closeOverlay();
    return;
  }
}

async function applyRollback(ctx, action) {
  const adapters = ctx.adapters || {};
  if (adapters.rollback) {
    await adapters.rollback(action);
    return;
  }
  const source = action.previousSource || (ctx.previousSources && ctx.previousSources[action.installId]);
  if (!source) throw new Error("Previous version payload is not available.");
  copyCurrentPayload(ctx, action);
  const preview = await smartInstall.analyze({
    source,
    dutyPath: ctx.dutyPath,
    dataDir: ctx.dataDir,
    stagingRoot: ctx.stagingRoot || path.join(ctx.actionRoot, "staging"),
  });
  await smartInstall.commit({ preview, dutyPath: ctx.dutyPath, dataDir: ctx.dataDir });
}

function copyCurrentPayload(ctx, action) {
  const src = path.join(ctx.dataDir, "store", action.installId);
  const dest = path.join(store.snapshotDir(ctx.actionRoot, action.actionId), "payload");
  const manifest = manifestStore.read(ctx.dataDir, action.installId);
  if (manifest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(path.join(store.snapshotDir(ctx.actionRoot, action.actionId), "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
}

async function executeRestore(ctx, action) {
  const adapters = ctx.adapters || {};
  if (action.type === ACTION_TYPES.CLOSE_OVERLAY_AND_RETEST) return;
  if (action.type === ACTION_TYPES.ROLLBACK_MOD_AND_RETEST) {
    if (adapters.restoreRollback) {
      await adapters.restoreRollback(action);
      return;
    }
    restoreRolledBackManifest(ctx, action);
    return;
  }
  if (action.type === ACTION_TYPES.REPAIR_MOD_AND_RETEST || action.type === ACTION_TYPES.REPAIR_EXISTING_DEPENDENCY) {
    return;
  }
  const snapshots = (action.snapshot && action.snapshot.mods) || [];
  for (const row of snapshots) {
    if (adapters.setEnabled) await adapters.setEnabled({ modId: row.installId, enabled: row.enabled });
    else await smartInstall.setEnabled({ modId: row.installId, dutyPath: ctx.dutyPath, dataDir: ctx.dataDir, enabled: row.enabled });
  }
}

function restoreRolledBackManifest(ctx, action) {
  const snap = path.join(store.snapshotDir(ctx.actionRoot, action.actionId), "manifest.json");
  const payload = path.join(store.snapshotDir(ctx.actionRoot, action.actionId), "payload");
  if (!fs.existsSync(snap)) {
    if (ctx.adapters && ctx.adapters.restoreRollback) return ctx.adapters.restoreRollback(action);
    throw new Error("Pre-test version snapshot is missing.");
  }
  const manifest = JSON.parse(fs.readFileSync(snap, "utf8"));
  if (fs.existsSync(payload) && ctx.dutyPath) {
    for (const file of manifest.files || []) {
      const from = path.join(payload, String(file.destination || "").split("/").join(path.sep));
      const to = path.join(ctx.dutyPath, String(file.destination || "").split("/").join(path.sep));
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
  }
  manifestStore.write(ctx.dataDir, manifest);
}

async function restoreAction(ctx, actionId) {
  const action = store.getAction(ctx.actionRoot, actionId);
  if (!action) throw new Error("That crash action was not found.");
  await executeRestore(ctx, action);
  action.state = ACTION_STATES.RESTORED;
  action.resolution = "RESTORED";
  action.restoredAt = ctx.now();
  persist(ctx, action);
  audit(ctx, "CRASH_ACTION_RESTORED", action);
  return action;
}

function keepAction(ctx, actionId) {
  const action = store.getAction(ctx.actionRoot, actionId);
  if (!action) throw new Error("That crash action was not found.");
  action.resolution = action.type === ACTION_TYPES.DISABLE_MOD_AND_RETEST ? "KEEP_DISABLED" : "KEEP_CURRENT";
  action.keptAt = ctx.now();
  persist(ctx, action);
  return action;
}

function markRetestLaunched(ctx, actionId, retestSessionId) {
  const action = store.getAction(ctx.actionRoot, actionId);
  if (!action) return null;
  action.state = ACTION_STATES.RETEST_LAUNCHED;
  action.retestSessionId = retestSessionId;
  action.retestLaunchedAt = ctx.now();
  persist(ctx, action);
  audit(ctx, "CRASH_RETEST_LAUNCHED", action, { retestSessionId });
  return action;
}

function completeRetest(ctx, retestSession) {
  if (!retestSession || !retestSession.crashActionId) return null;
  const action = store.getAction(ctx.actionRoot, retestSession.crashActionId);
  if (!action) return null;
  const classified = classifyRetest(
    { durationMs: action.snapshot && action.snapshot.originalDurationMs, result: action.snapshot && action.snapshot.originalResult },
    retestSession
  );
  action.state = ACTION_STATES.RETEST_COMPLETED;
  action.retestSessionId = retestSession.sessionId;
  action.retest = {
    outcome: classified.outcome,
    confidence: classified.confidence,
    summary: classified.summary,
    durationMs: retestSession.durationMs || 0,
    result: retestSession.result,
    evidenceType: classified.outcome === "NO_CRASH_OBSERVED" ? "RETEST_NO_CRASH" : classified.outcome === "CRASH_REPRODUCED" ? "RETEST_CRASH_REPRODUCED" : classified.outcome,
  };
  persist(ctx, action);
  audit(ctx, "CRASH_RETEST_COMPLETED", action, { outcome: classified.outcome, retestSessionId: retestSession.sessionId });
  return action;
}

function pendingForLaunch(actionRoot) {
  return store.pendingActions(actionRoot).find((row) => row.state === ACTION_STATES.APPLIED) || null;
}

function recoveryState(actionRoot) {
  const pending = store.latestPending(actionRoot);
  if (pending && pending.state === ACTION_STATES.APPLIED && !pending.retestSessionId) {
    return { status: "APPLIED_AWAITING_LAUNCH", action: pending };
  }
  if (pending && pending.state === ACTION_STATES.RETEST_LAUNCHED) {
    return { status: "RETEST_IN_PROGRESS", action: pending };
  }
  for (const row of store.listActions(actionRoot, 12)) {
    const action = store.getAction(actionRoot, row.actionId);
    if (action && action.state === ACTION_STATES.RETEST_COMPLETED && !action.resolution) {
      return { status: "RETEST_COMPLETED", action };
    }
  }
  return { status: "NONE", action: null };
}

function retestEvidenceByInstall(actionRoot) {
  const map = {};
  for (const row of store.listActions(actionRoot, 80)) {
    const action = store.getAction(actionRoot, row.actionId);
    if (!action || !action.installId || !action.retest) continue;
    map[action.installId] = action.retest.evidenceType || action.retest.outcome;
  }
  return map;
}

function createContext(options = {}) {
  const session = options.session;
  const analysis = options.analysis || (options.sessionRoot && session ? getAnalysis(options.sessionRoot, session.sessionId) : null);
  return {
    actionRoot: options.actionRoot,
    sessionRoot: options.sessionRoot,
    dataDir: options.dataDir,
    dutyPath: options.dutyPath,
    stagingRoot: options.stagingRoot,
    session,
    analysis,
    inventory: options.inventory || (options.dataDir ? smartInstall.list(options.dataDir, options.dutyPath || "") : []),
    adapters: options.adapters || {},
    previousSources: options.previousSources || {},
    persist: options.persist,
    now: options.now || (() => new Date().toISOString()),
  };
}

module.exports = {
  createContext,
  planForSession,
  applyAction,
  restoreAction,
  keepAction,
  markRetestLaunched,
  completeRetest,
  pendingForLaunch,
  recoveryState,
  retestEvidenceByInstall,
  envFingerprint,
  staleGuard,
  newId,
  ACTION_TYPES,
  ACTION_STATES,
};
