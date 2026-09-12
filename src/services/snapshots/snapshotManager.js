const crypto = require("crypto");
const path = require("path");
const store = require("./snapshotStore");
const { SCHEMA_VERSION, REASONS, RETENTION, AUDIT_EVENTS } = require("./snapshotTypes");
const { ProfileError, CODES } = require("../profiles/profileTypes");
const state = require("../profiles/managedState");
const { appendAudit } = require("../smartAudit");

function newId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `snap-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function create(ctx, extras = {}) {
  state.assertDutyTarget(ctx);
  const snapshotId = extras.snapshotId || newId();
  const captured = state.captureManagedState({
    dataDir: ctx.dataDir,
    dutyPath: ctx.dutyPath,
    blobRoot: store.blobRoot(ctx.snapshotRoot),
    payloadRoot: store.payloadRoot(ctx.snapshotRoot, snapshotId),
  });
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    snapshotId,
    name: extras.name || defaultName(extras.reason),
    createdAt: nowIso(),
    reason: extras.reason || REASONS.MANUAL,
    pinned: Boolean(extras.pinned),
    knownGood: Boolean(extras.knownGood),
    environment: captured.environment,
    mods: captured.mods,
    configs: captured.configs,
    protectedFiles: captured.environment.protectedFiles || [],
    profileId: extras.profileId || null,
  };
  store.writeSnapshot(ctx.snapshotRoot, snapshot);
  prune(ctx);
  appendAudit(ctx.dataDir, "SNAPSHOT_CREATED", { snapshotId, reason: snapshot.reason, name: snapshot.name });
  return snapshot;
}

function defaultName(reason) {
  if (reason === REASONS.BEFORE_UPDATE) return "Before managed update";
  if (reason === REASONS.BEFORE_DOWNGRADE) return "Before managed downgrade";
  if (reason === REASONS.BEFORE_PROFILE_SWITCH) return "Before profile switch";
  if (reason === REASONS.BEFORE_CRASH_ACTION) return "Before crash action";
  if (reason === REASONS.BEFORE_REPAIR) return "Before repair";
  return "Manual snapshot";
}

function pin(ctx, snapshotId, pinned = true) {
  const snapshot = store.getSnapshot(ctx.snapshotRoot, snapshotId);
  if (!snapshot) throw new Error("Snapshot not found.");
  snapshot.pinned = Boolean(pinned);
  store.writeSnapshot(ctx.snapshotRoot, snapshot);
  appendAudit(ctx.dataDir, "SNAPSHOT_PINNED", { snapshotId, pinned: snapshot.pinned });
  return snapshot;
}

function remove(ctx, snapshotId) {
  store.deleteSnapshot(ctx.snapshotRoot, snapshotId);
  appendAudit(ctx.dataDir, "SNAPSHOT_DELETED", { snapshotId });
}

function prune(ctx) {
  const rows = store.listSnapshots(ctx.snapshotRoot).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const manuals = rows.filter((row) => row.reason === REASONS.MANUAL && !row.pinned && !row.knownGood);
  const autos = rows.filter((row) => row.reason !== REASONS.MANUAL && !row.pinned && !row.knownGood);
  for (const row of manuals.slice(RETENTION.MANUAL)) store.deleteSnapshot(ctx.snapshotRoot, row.snapshotId);
  for (const row of autos.slice(RETENTION.AUTOMATIC)) store.deleteSnapshot(ctx.snapshotRoot, row.snapshotId);
}

function environmentWarning(snapshot, currentEnv) {
  const left = snapshot.environment || {};
  const right = currentEnv || {};
  if (left.gtaVersion === right.gtaVersion && left.rphVersion === right.rphVersion && left.lspdfrVersion === right.lspdfrVersion) {
    return null;
  }
  return {
    title: "ENVIRONMENT CHANGED",
    snapshot: `GTA ${left.gtaVersion} · RPH ${left.rphVersion} · LSPDFR ${left.lspdfrVersion}`,
    current: `GTA ${right.gtaVersion} · RPH ${right.rphVersion} · LSPDFR ${right.lspdfrVersion}`,
  };
}

function planRestore(ctx, snapshotId) {
  state.assertDutyTarget(ctx);
  const snapshot = store.getSnapshot(ctx.snapshotRoot, snapshotId);
  if (!snapshot) throw new Error("Snapshot not found.");
  const current = state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath });
  const lookup = (installId, version) => {
    const dest = path.join(store.payloadRoot(ctx.snapshotRoot, snapshotId), installId, String(version || "UNKNOWN"));
    return require("fs").existsSync(dest) || (current.mods || []).some((mod) => mod.installId === installId && mod.version === version);
  };
  const plan = state.planDiff(current, snapshot, { payloadLookup: lookup });
  plan.snapshotId = snapshotId;
  plan.snapshotName = snapshot.name;
  plan.ops = state.operationsFromPlan(plan, snapshot);
  plan.environmentWarning = environmentWarning(snapshot, current.environment);
  plan.safe = plan.complete;
  return { snapshot, plan, current };
}

function validateRestore(ctx, snapshot) {
  if (!snapshot) throw new ProfileError(CODES.NOT_SAFE, "Snapshot is missing.");
  if (!snapshot.mods) throw new ProfileError(CODES.NOT_SAFE, "Snapshot manifests are unreadable.");
  state.assertDutyTarget(ctx);
  state.assertGameIdle(ctx.processAdapter);
  return true;
}

async function restore(ctx, snapshotId, extras = {}) {
  const preview = planRestore(ctx, snapshotId);
  validateRestore(ctx, preview.snapshot);
  if (!preview.plan.complete) {
    throw new ProfileError(CODES.PROFILE_INCOMPLETE, preview.plan.incomplete[0] ? preview.plan.incomplete[0].message : "Snapshot is incomplete.");
  }
  const beforeHash = state.stateHash(preview.current);
  appendAudit(ctx.dataDir, "SNAPSHOT_RESTORE_STARTED", { snapshotId });
  try {
    await state.applyOperations(preview.plan.ops, {
      dataDir: ctx.dataDir,
      dutyPath: ctx.dutyPath,
      blobRoot: store.blobRoot(ctx.snapshotRoot),
      payloadRoot: store.payloadRoot(ctx.snapshotRoot, snapshotId),
      adapters: ctx.adapters,
      hooks: extras.hooks,
    });
  } catch (error) {
    appendAudit(ctx.dataDir, "SNAPSHOT_RESTORE_ROLLED_BACK", { snapshotId, details: error.message });
    error.preHash = beforeHash;
    error.rolledBackHash = state.stateHash(state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath }));
    throw error;
  }
  appendAudit(ctx.dataDir, "SNAPSHOT_RESTORED", { snapshotId });
  return {
    snapshot: preview.snapshot,
    plan: preview.plan,
    preHash: beforeHash,
    postHash: state.stateHash(state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath })),
  };
}

function describePlan(plan, snapshot) {
  const lines = ["RESTORE SNAPSHOT", "", snapshot && snapshot.createdAt ? snapshot.createdAt.slice(0, 10) : "", snapshot ? snapshot.name : "", ""];
  lines.push("Mods:");
  lines.push(`${plan.disable.length} will be disabled`);
  lines.push(`${plan.enable.length} will be enabled`);
  lines.push(`${plan.restoreVersion.length} versions restored`);
  lines.push("");
  lines.push("Configs:");
  lines.push(`${plan.configChanges.length} restored`);
  if (plan.environmentWarning) {
    lines.push("");
    lines.push(plan.environmentWarning.title);
    lines.push(`This snapshot was created on: ${plan.environmentWarning.snapshot}`);
    lines.push(`Current: ${plan.environmentWarning.current}`);
  }
  return lines.filter(Boolean).join("\n");
}

function storageUsage(profileRoot, snapshotRoot) {
  return {
    profilesBytes: state.folderSize(profileRoot),
    snapshotsBytes: state.folderSize(snapshotRoot),
    bytes: state.folderSize(profileRoot) + state.folderSize(snapshotRoot),
  };
}

function latestId(root) {
  const rows = store.listSnapshots(root);
  return rows[0] ? rows[0].snapshotId : null;
}

module.exports = {
  REASONS,
  create,
  pin,
  remove,
  prune,
  planRestore,
  restore,
  validateRestore,
  describePlan,
  storageUsage,
  latestId,
  environmentWarning,
};
