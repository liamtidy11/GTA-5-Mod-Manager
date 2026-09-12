const crypto = require("crypto");
const store = require("./profileStore");
const { SCHEMA_VERSION, HEALTH, AUDIT_EVENTS, ProfileError, CODES } = require("./profileTypes");
const state = require("./managedState");
const { appendAudit } = require("../smartAudit");

function newId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `profile-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function audit(dataDir, event, extra = {}) {
  if (AUDIT_EVENTS.includes(event) || true) appendAudit(dataDir, event, extra);
}

function healthOf(profile, current, payloadLookup) {
  if (!profile) return HEALTH.BROKEN;
  if (profile.corrupt) return HEALTH.BROKEN;
  const diff = state.planDiff(current || { mods: [], configs: [] }, profile, { payloadLookup });
  if (diff.incomplete.length) return HEALTH.INCOMPLETE;
  if ((profile.mods || []).some((mod) => /UNKNOWN|WARNING|NOT_RECOMMENDED/.test(mod.compatibility || ""))) return HEALTH.WARNING;
  if (profile.drifted) return HEALTH.WARNING;
  return HEALTH.HEALTHY;
}

function compatibilitySummary(profile, inventory = []) {
  const byId = new Map(inventory.map((mod) => [mod.id || mod.installId, mod]));
  let likely = 0;
  let unknown = 0;
  let depProblems = 0;
  for (const row of profile.mods || []) {
    const live = byId.get(row.installId);
    const status = (live && (live.compatibilityStatus || live.compatibility)) || row.compatibility || "UNKNOWN";
    if (status === "UNKNOWN") unknown += 1;
    else likely += 1;
    const summary = live && live.dependencySummary;
    if (summary && summary.hasBlockingDependencyIssue) depProblems += 1;
  }
  return {
    name: profile.name,
    mods: (profile.mods || []).length,
    likely,
    unknown,
    dependencyProblems: depProblems,
  };
}

function payloadLookupFor(ctx) {
  return (installId, version) => {
    const current = (ctx.current && ctx.current.mods || []).find((mod) => mod.installId === installId);
    if (current && current.version === version) return true;
    if (ctx.payloadLookup) return Boolean(ctx.payloadLookup(installId, version));
    if (ctx.snapshotPayloadRoot) {
      const dest = require("path").join(ctx.snapshotPayloadRoot, installId, String(version || "UNKNOWN"));
      return require("fs").existsSync(dest);
    }
    return false;
  };
}

function captureProfileRecord(ctx, extras = {}) {
  const captured = state.captureManagedState({
    dataDir: ctx.dataDir,
    dutyPath: ctx.dutyPath,
    blobRoot: extras.blobRoot || "",
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    profileId: extras.profileId || newId(),
    name: extras.name || "Untitled profile",
    createdAt: extras.createdAt || nowIso(),
    updatedAt: nowIso(),
    description: extras.description || "",
    mods: captured.mods.map((mod) => ({
      installId: mod.installId,
      canonicalModId: mod.canonicalModId,
      name: mod.name,
      version: mod.version,
      enabled: mod.enabled,
      compatibility: mod.compatibility,
    })),
    configs: captured.configs,
    launchPreferences: extras.launchPreferences || {},
    knownGood: Boolean(extras.knownGood),
    drifted: false,
    environment: captured.environment,
  };
}

function migrateIfNeeded(ctx) {
  const index = store.loadIndex(ctx.profileRoot);
  if (index.profiles.length) return store.getProfile(ctx.profileRoot, index.activeProfileId) || store.listProfiles(ctx.profileRoot)[0] || null;
  const before = state.stateHash(state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath }));
  const profile = captureProfileRecord(ctx, { name: "Current Setup", blobRoot: store.configBlobRoot(ctx.profileRoot, "pending") });
  const dest = store.configBlobRoot(ctx.profileRoot, profile.profileId);
  require("fs").mkdirSync(dest, { recursive: true });
  if (require("fs").existsSync(store.configBlobRoot(ctx.profileRoot, "pending"))) {
    require("fs").cpSync(store.configBlobRoot(ctx.profileRoot, "pending"), dest, { recursive: true });
    require("fs").rmSync(store.configBlobRoot(ctx.profileRoot, "pending"), { recursive: true, force: true });
  }
  store.writeProfile(ctx.profileRoot, profile);
  const next = store.loadIndex(ctx.profileRoot);
  next.activeProfileId = profile.profileId;
  store.saveIndex(ctx.profileRoot, next);
  audit(ctx.dataDir, "PROFILE_CREATED", { profileId: profile.profileId, name: profile.name, migrated: true });
  const after = state.stateHash(state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath }));
  if (before !== after) throw new ProfileError("MIGRATION_CHANGED_DUTY", "Migration must not change Duty files.");
  return profile;
}

function createFromCurrent(ctx, extras = {}) {
  state.assertDutyTarget(ctx);
  const profile = captureProfileRecord(ctx, {
    name: extras.name || "New profile",
    description: extras.description || "",
    blobRoot: store.configBlobRoot(ctx.profileRoot, "pending"),
  });
  require("fs").mkdirSync(store.configBlobRoot(ctx.profileRoot, profile.profileId), { recursive: true });
  const pending = store.configBlobRoot(ctx.profileRoot, "pending");
  if (require("fs").existsSync(pending)) {
    require("fs").cpSync(pending, store.configBlobRoot(ctx.profileRoot, profile.profileId), { recursive: true });
    require("fs").rmSync(pending, { recursive: true, force: true });
  }
  profile.health = healthOf(profile, state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath }), payloadLookupFor(ctx));
  store.writeProfile(ctx.profileRoot, profile);
  const index = store.loadIndex(ctx.profileRoot);
  if (!index.activeProfileId) {
    index.activeProfileId = profile.profileId;
    store.saveIndex(ctx.profileRoot, index);
  }
  audit(ctx.dataDir, "PROFILE_CREATED", { profileId: profile.profileId, name: profile.name });
  return profile;
}

function rename(ctx, profileId, name) {
  const profile = store.getProfile(ctx.profileRoot, profileId);
  if (!profile) throw new Error("Profile not found.");
  profile.name = String(name || "").trim() || profile.name;
  profile.updatedAt = nowIso();
  store.writeProfile(ctx.profileRoot, profile);
  audit(ctx.dataDir, "PROFILE_UPDATED", { profileId, name: profile.name });
  return profile;
}

function duplicate(ctx, profileId, name) {
  const profile = store.getProfile(ctx.profileRoot, profileId);
  if (!profile) throw new Error("Profile not found.");
  const copy = {
    ...profile,
    profileId: newId(),
    name: name || `${profile.name} copy`,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    knownGood: false,
    drifted: false,
  };
  store.writeProfile(ctx.profileRoot, copy);
  const src = store.configBlobRoot(ctx.profileRoot, profileId);
  if (require("fs").existsSync(src)) {
    require("fs").cpSync(src, store.configBlobRoot(ctx.profileRoot, copy.profileId), { recursive: true });
  }
  audit(ctx.dataDir, "PROFILE_CREATED", { profileId: copy.profileId, name: copy.name, duplicatedFrom: profileId });
  return copy;
}

function remove(ctx, profileId) {
  const index = store.loadIndex(ctx.profileRoot);
  if (index.profiles.length <= 1) throw new Error("Keep at least one profile.");
  store.deleteProfile(ctx.profileRoot, profileId);
  return store.loadIndex(ctx.profileRoot);
}

function markKnownGood(ctx, profileId) {
  const profiles = store.listProfiles(ctx.profileRoot);
  for (const profile of profiles) {
    profile.knownGood = profile.profileId === profileId;
    profile.updatedAt = nowIso();
    store.writeProfile(ctx.profileRoot, profile);
  }
  const index = store.loadIndex(ctx.profileRoot);
  index.knownGoodProfileId = profileId;
  store.saveIndex(ctx.profileRoot, index);
  audit(ctx.dataDir, "PROFILE_MARKED_KNOWN_GOOD", { profileId });
  return store.getProfile(ctx.profileRoot, profileId);
}

function knownGoodEvidence(sessions = []) {
  const clean = (sessions || []).filter((row) => row.result === "CLEAN_EXIT");
  const last5 = (sessions || []).slice(0, 5);
  const runtime = clean.reduce((sum, row) => sum + (Number(row.durationMs) || 0), 0);
  return {
    cleanSessions: clean.length,
    totalStableMs: runtime,
    noCrashesInLast5: last5.length > 0 && last5.every((row) => row.result === "CLEAN_EXIT"),
  };
}

function driftAgainst(profile, current) {
  const notes = [];
  const have = new Map((current.mods || []).map((mod) => [mod.installId, mod]));
  for (const want of profile.mods || []) {
    const live = have.get(want.installId);
    if (!live) {
      notes.push(`${want.name || want.installId} is missing`);
      continue;
    }
    if (Boolean(live.enabled) !== Boolean(want.enabled)) {
      notes.push(`${live.name} ${live.enabled ? "enabled" : "disabled"}`);
    }
    if ((live.version || "") !== (want.version || "")) {
      notes.push(`${live.name} updated ${want.version} → ${live.version}`);
    }
  }
  for (const live of current.mods || []) {
    if (!(profile.mods || []).some((mod) => mod.installId === live.installId) && live.enabled) {
      notes.push(`${live.name} enabled`);
    }
  }
  return { drifted: notes.length > 0, notes };
}

function markDrifted(ctx, notes = []) {
  const index = store.loadIndex(ctx.profileRoot);
  if (!index.activeProfileId) return null;
  const profile = store.getProfile(ctx.profileRoot, index.activeProfileId);
  if (!profile) return null;
  profile.drifted = true;
  profile.updatedAt = nowIso();
  store.writeProfile(ctx.profileRoot, profile);
  index.drifted = true;
  index.driftNotes = notes;
  store.saveIndex(ctx.profileRoot, index);
  return { profileId: profile.profileId, drifted: true, notes };
}

function updateProfileFromCurrent(ctx, profileId) {
  const existing = store.getProfile(ctx.profileRoot, profileId);
  if (!existing) throw new Error("Profile not found.");
  const next = captureProfileRecord(ctx, {
    profileId,
    name: existing.name,
    createdAt: existing.createdAt,
    description: existing.description,
    knownGood: existing.knownGood,
    launchPreferences: existing.launchPreferences,
    blobRoot: store.configBlobRoot(ctx.profileRoot, profileId),
  });
  next.drifted = false;
  store.writeProfile(ctx.profileRoot, next);
  const index = store.loadIndex(ctx.profileRoot);
  if (index.activeProfileId === profileId) {
    index.drifted = false;
    index.driftNotes = [];
    store.saveIndex(ctx.profileRoot, index);
  }
  audit(ctx.dataDir, "PROFILE_UPDATED", { profileId, fromCurrent: true });
  return next;
}

function planSwitch(ctx, profileId) {
  state.assertDutyTarget(ctx);
  const profile = store.getProfile(ctx.profileRoot, profileId);
  if (!profile) throw new Error("Profile not found.");
  const current = state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath });
  const plan = state.planDiff(current, profile, { payloadLookup: payloadLookupFor({ ...ctx, current }) });
  const external = [];
  for (const row of profile.configs || []) {
    const nowHash = state.currentConfigHash(ctx.dutyPath, row.destination);
    if (nowHash && nowHash !== row.hash) {
      const captured = (current.configs || []).find((item) => item.destination === row.destination);
      if (captured && captured.hash !== row.hash) {
        external.push({ destination: row.destination, currentHash: nowHash, profileHash: row.hash });
      }
    }
  }
  plan.externalConfigs = external;
  plan.profileId = profileId;
  plan.profileName = profile.name;
  plan.ops = state.operationsFromPlan(plan, profile);
  plan.safe = plan.complete && !external.length;
  plan.incompleteMessage = plan.incomplete[0]
    ? `PROFILE INCOMPLETE\n\n${plan.incomplete[0].message}`
    : "";
  return plan;
}

async function switchProfile(ctx, profileId, extras = {}) {
  state.assertDutyTarget(ctx);
  state.assertGameIdle(ctx.processAdapter);
  const profile = store.getProfile(ctx.profileRoot, profileId);
  if (!profile) throw new Error("Profile not found.");
  const plan = planSwitch(ctx, profileId);
  if (plan.externalConfigs.length && extras.confirmOverwriteConfigs) {
    for (const row of plan.externalConfigs) {
      if (!plan.configChanges.some((item) => item.destination === row.destination)) {
        plan.configChanges.push({ destination: row.destination, hash: row.profileHash, installId: row.installId });
      }
    }
    plan.ops = state.operationsFromPlan(plan, profile);
  }
  if (plan.externalConfigs.length && !extras.confirmOverwriteConfigs) {
    const error = new ProfileError(
      "CONFIG_CHANGED_OUTSIDE",
      `CONFIG CHANGED OUTSIDE MOD MANAGER\n\n${plan.externalConfigs.map((row) => row.destination).join("\n")}\n\nCurrent file differs from the profile version.`
    );
    error.plan = plan;
    throw error;
  }
  if (!plan.complete) {
    throw new ProfileError(CODES.PROFILE_INCOMPLETE, plan.incompleteMessage);
  }
  if (ctx.beforeSwitch) await ctx.beforeSwitch(plan);
  const beforeHash = state.stateHash(state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath }));
  audit(ctx.dataDir, "PROFILE_SWITCH_STARTED", { profileId, name: profile.name });
  try {
    await state.applyOperations(plan.ops, {
      dataDir: ctx.dataDir,
      dutyPath: ctx.dutyPath,
      blobRoot: store.configBlobRoot(ctx.profileRoot, profileId),
      payloadRoot: ctx.payloadRoot,
      payloadLookup: ctx.payloadLookup,
      adapters: ctx.adapters,
      hooks: extras.hooks,
    });
  } catch (error) {
    audit(ctx.dataDir, "PROFILE_SWITCH_ROLLED_BACK", { profileId, details: error.message });
    const afterFail = state.stateHash(state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath }));
    error.rolledBackHash = afterFail;
    error.preHash = beforeHash;
    throw error;
  }
  const index = store.loadIndex(ctx.profileRoot);
  index.activeProfileId = profileId;
  index.drifted = false;
  index.driftNotes = [];
  store.saveIndex(ctx.profileRoot, index);
  profile.drifted = false;
  profile.updatedAt = nowIso();
  store.writeProfile(ctx.profileRoot, profile);
  audit(ctx.dataDir, "PROFILE_SWITCH_COMPLETED", { profileId, name: profile.name });
  return { profile, plan, preHash: beforeHash, postHash: state.stateHash(state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath })) };
}

function activeSummary(ctx) {
  migrateIfNeeded(ctx);
  const index = store.loadIndex(ctx.profileRoot);
  const profile = index.activeProfileId ? store.getProfile(ctx.profileRoot, index.activeProfileId) : null;
  if (!profile) return null;
  const current = state.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath });
  const drift = driftAgainst(profile, current);
  const inventory = state.listManaged(ctx.dataDir, ctx.dutyPath);
  return {
    profile,
    index,
    health: healthOf(profile, current, payloadLookupFor({ ...ctx, current })),
    drift,
    compatibility: compatibilitySummary(profile, inventory),
    enabledCount: (current.mods || []).filter((mod) => mod.enabled).length,
  };
}

function describePlan(plan) {
  const lines = [`SWITCH TO: ${String(plan.profileName || "").toUpperCase()}`, ""];
  if (plan.disable.length) {
    lines.push("Disable:");
    for (const row of plan.disable) lines.push(`• ${row.name}`);
    lines.push("");
  }
  if (plan.enable.length) {
    lines.push("Enable:");
    for (const row of plan.enable) lines.push(`• ${row.name}`);
    lines.push("");
  }
  if (plan.restoreVersion.length) {
    lines.push("Restore version:");
    for (const row of plan.restoreVersion) lines.push(`• ${row.name} ${row.to}`);
    lines.push("");
  }
  if (plan.configChanges.length) {
    lines.push("Configs:");
    lines.push(`• ${plan.configChanges.length} managed configs changed`);
  }
  if (plan.incomplete.length) lines.push(plan.incompleteMessage);
  return lines.join("\n").trim();
}

module.exports = {
  newId,
  migrateIfNeeded,
  createFromCurrent,
  rename,
  duplicate,
  remove,
  markKnownGood,
  knownGoodEvidence,
  driftAgainst,
  markDrifted,
  updateProfileFromCurrent,
  planSwitch,
  switchProfile,
  activeSummary,
  healthOf,
  compatibilitySummary,
  describePlan,
  captureProfileRecord,
};
