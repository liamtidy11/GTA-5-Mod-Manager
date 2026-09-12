const fs = require("fs");
const path = require("path");
const payloadStore = require("../payloadStore");
const managedState = require("../profiles/managedState");
const snapshotStore = require("../snapshots/snapshotStore");
const { ProfileError, CODES } = require("../profiles/profileTypes");

// Local update intelligence. Never downloads, never auto-updates. Turns a
// dropped package preview into a plain-language update summary plus a
// deterministic risk score. Version rollback reuses the V5 transactional
// engine and stored payloads; it never fakes a restoration.

const RISK = { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH", UNKNOWN: "UNKNOWN" };

function normalize(value) {
  return String(value == null ? "" : value).trim();
}

// Deterministic risk. Risk never comes from the version number alone.
function scoreUpdateRisk(factors = {}) {
  const reasons = [];
  const high = [];
  const medium = [];

  if (factors.parkedFrameworkRequired) high.push("A parked framework would need to be re-enabled.");
  if (factors.compatibilityWarning) high.push("Trusted data records a compatibility warning.");
  if (factors.ownershipConflict) high.push("This package overwrites files owned by another mod.");
  if (factors.crashRegressionHistory) high.push("Crashes were recorded after a previous update to this mod.");
  if (factors.protectedFileConflict) high.push("This package touches a protected launch file.");

  if (factors.compatibilityUnknown) medium.push("Runtime compatibility is unknown for this Duty setup.");
  if (factors.dependencyChanges) medium.push("Dependencies change in this version.");
  if (factors.configSchemaChange) medium.push("A managed config would change.");

  if (high.length) {
    return { level: RISK.HIGH, reasons: high.concat(medium) };
  }
  if (medium.length) {
    return { level: RISK.MEDIUM, reasons: medium };
  }
  // Enough positive evidence to call it low, otherwise we stay honest.
  const knownLow =
    factors.compatibilitySameOrVerified === true &&
    factors.dependenciesSame === true &&
    factors.configsPreserved === true &&
    factors.noProtectedFiles === true;
  if (knownLow) {
    reasons.push("Same dependencies, configs preserved, no protected files, compatibility unchanged.");
    return { level: RISK.LOW, reasons };
  }
  return { level: RISK.UNKNOWN, reasons: ["Not enough local evidence to score this update."] };
}

function crashRegressionHistory(installId, sessions = []) {
  // A crash session that ran a NEWER version of this mod after an update event.
  return (sessions || []).some((session) => {
    const failed = ["GAME_CRASH", "RPH_CRASH", "LSPDFR_CRASH"].includes(session.result);
    if (!failed) return false;
    return (session.recentChanges || []).some(
      (change) => change.installId === installId && /UPDATED|DOWNGRADED/.test(change.event || "")
    );
  });
}

// Build the UPDATE DETECTED summary from an installed manifest + a dropped
// package preview (the Smart Install analysis object).
function detectUpdate({ installed = null, preview = {}, userEntry = null, sessions = [] } = {}) {
  const installedVersion = normalize(installed && installed.version) || "UNKNOWN";
  const droppedVersion = normalize(preview.droppedVersion) || "UNKNOWN";
  const knownGoodVersion = normalize(userEntry && userEntry.knownGoodVersion) || null;
  const relation = (preview.duplicate && preview.duplicate.relation) || "UNKNOWN";
  const review = preview.updateReview || {};
  const counts = preview.counts || {};
  const summary = preview.dependencySummary || {};

  const newDependencies = Math.max(0, Number(summary.requiredTotal || 0) - Number((installed && installed.dependencySummary && installed.dependencySummary.requiredTotal) || 0));
  const configsPreserved = Array.isArray(review.configsPreserved) ? review.configsPreserved.length > 0 || (counts.skip || 0) > 0 : (preview.configPolicy === "KEEP_EXISTING");
  const compatibilityStatus = (preview.compatibility && preview.compatibility.status) || "UNKNOWN";

  const safetyFindings = (preview.installSafety && preview.installSafety.findings) || [];
  const protectedFileConflict = safetyFindings.some((f) => f.code === "PROTECTED_FILE");
  const ownershipConflict = (preview.conflicts && (preview.conflicts.items || []).some((i) => /already-installed|owns/i.test(`${i.code} ${i.message}`))) || false;
  const parkedFrameworkRequired = (preview.resolvedDependencies || []).some((d) => d.kind === "REQUIRED" && d.state === "DISABLED");
  const dependencyChanges = newDependencies > 0 || (preview.resolvedDependencies || []).some((d) => d.kind === "REQUIRED" && ["MISSING", "VERSION_TOO_OLD", "VERSION_TOO_NEW"].includes(d.state));

  const risk = scoreUpdateRisk({
    parkedFrameworkRequired,
    compatibilityWarning: compatibilityStatus === "WARNING" || compatibilityStatus === "INCOMPATIBLE",
    compatibilityUnknown: compatibilityStatus === "UNKNOWN",
    ownershipConflict,
    protectedFileConflict,
    crashRegressionHistory: crashRegressionHistory((installed && installed.id) || "", sessions),
    dependencyChanges,
    configSchemaChange: false,
    compatibilitySameOrVerified: compatibilityStatus === "VERIFIED" || compatibilityStatus === "LIKELY_COMPATIBLE",
    dependenciesSame: !dependencyChanges,
    configsPreserved,
    noProtectedFiles: !protectedFileConflict,
  });

  return {
    installedVersion,
    droppedVersion,
    knownGoodVersion,
    relation,
    changes: {
      filesReplaced: Number(counts.replace || (review.replaced || []).length || 0),
      filesAdded: Number(counts.add || (review.added || []).length || 0),
      filesRemoved: (review.removed || []).length,
      newDependencies,
      configPreserved: configsPreserved,
      compatibility: compatibilityStatus,
    },
    risk,
  };
}

// ---- Version history + stored payloads -----------------------------------

function snapshotPayloadRoots(snapshotRoot) {
  try {
    return fs
      .readdirSync(snapshotRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => snapshotStore.payloadRoot(snapshotRoot, entry.name));
  } catch {
    return [];
  }
}

function storedVersions(ctx, installId) {
  const found = new Set();
  for (const root of snapshotPayloadRoots(ctx.snapshotRoot)) {
    const dir = path.join(root, installId);
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) found.add(entry.name);
      }
    } catch {
      /* ignore */
    }
  }
  return found;
}

function findVersionPayloadRoot(ctx, installId, version) {
  if (!version) return "";
  for (const root of snapshotPayloadRoots(ctx.snapshotRoot)) {
    if (fs.existsSync(path.join(root, installId, String(version)))) return root;
  }
  return "";
}

function versionHistory(ctx, installId) {
  const manifest = require("../manifestStore").read(ctx.dataDir, installId);
  const current = manifest ? normalize(manifest.version) || "UNKNOWN" : "UNKNOWN";
  const userEntry = require("../knowledge/userKnowledge").getEntry(ctx.dataDir, {
    installId,
    canonicalModId: manifest && manifest.canonicalModId,
  });
  const knownGood = normalize(userEntry && userEntry.knownGoodVersion) || null;

  const stored = storedVersions(ctx, installId);
  const currentHasPayload = fs.existsSync(payloadStore.storeRoot(ctx.dataDir, installId));

  const versions = new Map();
  const add = (version, extras) => {
    if (!version || version === "UNKNOWN") return;
    const prev = versions.get(version) || { version, current: false, knownGood: false, hasPayload: false };
    versions.set(version, { ...prev, ...extras });
  };
  add(current, { current: true, hasPayload: currentHasPayload });
  if (knownGood) add(knownGood, { knownGood: true, hasPayload: stored.has(knownGood) || knownGood === current });
  for (const version of stored) add(version, { hasPayload: true });

  const list = [...versions.values()].sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  // Only show versions actually stored (payload) or currently live.
  return list.filter((row) => row.hasPayload || row.current);
}

// ---- Known-good rollback (reuses V5 transactional engine) -----------------

function resolveKnownGood(ctx, installId) {
  const manifest = require("../manifestStore").read(ctx.dataDir, installId);
  if (!manifest) return { installId, knownGoodVersion: null, currentVersion: "UNKNOWN" };
  const userEntry = require("../knowledge/userKnowledge").getEntry(ctx.dataDir, {
    installId,
    canonicalModId: manifest.canonicalModId,
  });
  return {
    installId,
    name: manifest.name,
    currentVersion: normalize(manifest.version) || "UNKNOWN",
    knownGoodVersion: normalize(userEntry && userEntry.knownGoodVersion) || null,
  };
}

function planKnownGoodRestore(ctx, installId) {
  const info = resolveKnownGood(ctx, installId);
  if (!info.knownGoodVersion) {
    return { available: false, reason: "NO_KNOWN_GOOD", message: "No known-good version has been marked for this mod." };
  }
  if (info.knownGoodVersion === info.currentVersion) {
    return { available: false, reason: "ALREADY_KNOWN_GOOD", ...info, message: "The installed version is already the known-good version." };
  }
  const payloadRoot = findVersionPayloadRoot(ctx, installId, info.knownGoodVersion);
  if (!payloadRoot) {
    return {
      available: false,
      reason: "PACKAGE_UNAVAILABLE",
      ...info,
      message: `${info.name || installId} ${info.knownGoodVersion} is required but the package is no longer available.`,
    };
  }
  return { available: true, ...info, from: info.currentVersion, to: info.knownGoodVersion, payloadRoot };
}

async function restoreKnownGoodVersion(ctx, installId, extras = {}) {
  const plan = planKnownGoodRestore(ctx, installId);
  if (!plan.available) {
    throw new ProfileError(plan.reason === "PACKAGE_UNAVAILABLE" ? CODES.PROFILE_INCOMPLETE : "NO_KNOWN_GOOD", plan.message);
  }
  managedState.assertDutyTarget(ctx);
  managedState.assertGameIdle(ctx.processAdapter);
  if (extras.beforeRestore) await extras.beforeRestore(plan);
  const op = { type: "RESTORE_VERSION", installId, name: plan.name, from: plan.from, to: plan.to };
  const before = managedState.stateHash(managedState.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath }));
  try {
    await managedState.applyOperations([op], {
      dataDir: ctx.dataDir,
      dutyPath: ctx.dutyPath,
      payloadRoot: plan.payloadRoot,
      hooks: extras.hooks,
    });
  } catch (error) {
    error.preHash = before;
    error.rolledBackHash = managedState.stateHash(managedState.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath }));
    throw error;
  }
  return {
    installId,
    from: plan.from,
    to: plan.to,
    preHash: before,
    postHash: managedState.stateHash(managedState.captureManagedState({ dataDir: ctx.dataDir, dutyPath: ctx.dutyPath })),
  };
}

module.exports = {
  RISK,
  scoreUpdateRisk,
  detectUpdate,
  crashRegressionHistory,
  versionHistory,
  storedVersions,
  findVersionPayloadRoot,
  planKnownGoodRestore,
  restoreKnownGoodVersion,
};
