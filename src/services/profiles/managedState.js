const fs = require("fs");
const path = require("path");
const { isEnhancedFolder } = require("../paths");
const { isConfigFile } = require("../configPolicy");
const { hashString, hashFileSync, safeHashFileSync } = require("../hashUtil");
const smartInstall = require("../smartInstall");
const manifestStore = require("../manifestStore");
const payloadStore = require("../payloadStore");
const environmentInventory = require("../environmentInventory");
const { systemAdapter, snapshotKnown, findRunning, RPH_IMAGES, GTA_IMAGES } = require("../session/processMonitor");
const { ProfileError, CODES } = require("./profileTypes");

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

function assertDutyTarget({ dutyPath, officialPath }) {
  if (!dutyPath) throw new ProfileError(CODES.ONLINE_TARGET_REJECTED, "No Duty folder is set.");
  if (officialPath && path.resolve(dutyPath).toLowerCase() === path.resolve(officialPath).toLowerCase()) {
    throw new ProfileError(CODES.ONLINE_TARGET_REJECTED, "Profiles and snapshots never modify the Online folder.");
  }
  if (!isEnhancedFolder(dutyPath)) {
    throw new ProfileError(CODES.ONLINE_TARGET_REJECTED, "The target is not a GTA V Enhanced Duty folder.");
  }
}

function assertGameIdle(adapter) {
  const snap = snapshotKnown(adapter || systemAdapter(), [...RPH_IMAGES, ...GTA_IMAGES]);
  if (findRunning(snap, RPH_IMAGES) || findRunning(snap, GTA_IMAGES)) {
    throw new ProfileError(
      CODES.GAME_RUNNING,
      "GTA Enhanced or Rage Plugin Hook is still running. Close the game before switching profiles or restoring a snapshot. The manager will not close it for you."
    );
  }
}

function captureEnvironment(dutyPath, dataDir) {
  try {
    const inv = environmentInventory.getInventory({ dutyPath, dataDir });
    return {
      gtaVersion: (inv.gta && inv.gta.version) || "UNKNOWN",
      rphVersion: (inv.ragePluginHook && inv.ragePluginHook.version) || "UNKNOWN",
      lspdfrVersion: (inv.lspdfr && inv.lspdfr.version) || "UNKNOWN",
      protectedFiles: (inv.protectedFiles || []).map((row) => ({
        match: row.match || row.rel || row.file || "",
        present: row.present !== false,
        level: row.level || row.severity || "",
      })),
    };
  } catch {
    return { gtaVersion: "UNKNOWN", rphVersion: "UNKNOWN", lspdfrVersion: "UNKNOWN", protectedFiles: [] };
  }
}

function listManaged(dataDir, dutyPath = "") {
  try {
    return smartInstall.list(dataDir, dutyPath);
  } catch {
    return [];
  }
}

function collectConfigs(mods, dutyPath, blobRoot) {
  const configs = [];
  if (!dutyPath) return configs;
  for (const mod of mods || []) {
    for (const file of mod.files || []) {
      const dest = file.destination;
      if (!isConfigFile(dest)) continue;
      const abs = path.join(dutyPath, String(dest).split("/").join(path.sep));
      if (!fs.existsSync(abs)) continue;
      const hash = hashFileSync(abs);
      if (blobRoot) putBlob(blobRoot, hash, fs.readFileSync(abs));
      configs.push({
        installId: mod.id || mod.installId,
        destination: dest,
        hash,
        policy: mod.configPolicy || "KEEP_EXISTING",
      });
    }
  }
  return configs;
}

function putBlob(blobRoot, hash, buffer) {
  const dest = path.join(blobRoot, hash);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(blobRoot, { recursive: true });
  fs.writeFileSync(dest, buffer);
  return dest;
}

function readBlob(blobRoot, hash) {
  const dest = path.join(blobRoot, hash);
  if (!fs.existsSync(dest)) return null;
  return fs.readFileSync(dest);
}

function archivePayload(dataDir, installId, destRoot) {
  const src = payloadStore.storeRoot(dataDir, installId);
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(destRoot, { recursive: true });
  fs.cpSync(src, destRoot, { recursive: true });
  return true;
}

function payloadAvailable(dataDir, installId, version, payloadRoots = []) {
  const manifest = manifestStore.read(dataDir, installId);
  if (!manifest) return false;
  if ((manifest.version || "UNKNOWN") === (version || "UNKNOWN") && fs.existsSync(payloadStore.storeRoot(dataDir, installId))) {
    return true;
  }
  return payloadRoots.some((root) => root && fs.existsSync(root));
}

function captureManagedState({ dataDir, dutyPath, blobRoot = "", payloadRoot = "" } = {}) {
  const mods = listManaged(dataDir, dutyPath).map((mod) => {
    const installId = mod.id || mod.installId;
    if (payloadRoot && installId) {
      archivePayload(dataDir, installId, path.join(payloadRoot, installId, String(mod.version || "UNKNOWN")));
    }
    return {
      installId,
      canonicalModId: mod.canonicalModId || mod.recognitionModId || null,
      name: mod.name || "Mod",
      version: mod.version || "UNKNOWN",
      enabled: mod.enabled !== false,
      compatibility: mod.compatibilityStatus || mod.compatibility || "UNKNOWN",
      health: mod.cardHealth || mod.managedStatus || "UNKNOWN",
      configPolicy: mod.configPolicy || "KEEP_EXISTING",
      files: (mod.files || []).map((file) => file.destination),
    };
  });
  return {
    environment: captureEnvironment(dutyPath, dataDir),
    mods,
    configs: collectConfigs(listManaged(dataDir, dutyPath), dutyPath, blobRoot),
  };
}

function stateHash(state) {
  const payload = {
    mods: (state.mods || [])
      .map((mod) => ({ installId: mod.installId, version: mod.version || "", enabled: mod.enabled !== false }))
      .sort((a, b) => String(a.installId).localeCompare(String(b.installId))),
    configs: (state.configs || [])
      .map((row) => ({ destination: row.destination, hash: row.hash }))
      .sort((a, b) => String(a.destination).localeCompare(String(b.destination))),
  };
  return hashString(JSON.stringify(payload));
}

function currentConfigHash(dutyPath, destination) {
  const abs = path.join(dutyPath, String(destination).split("/").join(path.sep));
  return safeHashFileSync(abs);
}

function planDiff(current, target, { payloadLookup } = {}) {
  const currentMods = new Map((current.mods || []).map((mod) => [mod.installId, mod]));
  const targetMods = target.mods || [];
  const disable = [];
  const enable = [];
  const restoreVersion = [];
  const missing = [];
  const incomplete = [];

  for (const want of targetMods) {
    const have = currentMods.get(want.installId);
    if (!have) {
      missing.push(want);
      incomplete.push({
        installId: want.installId,
        name: want.name,
        message: `${want.name || want.installId} is required but the package is no longer available.`,
      });
      continue;
    }
    if ((have.version || "UNKNOWN") !== (want.version || "UNKNOWN")) {
      const available = payloadLookup ? payloadLookup(want.installId, want.version) : have.version === want.version;
      if (!available) {
        incomplete.push({
          installId: want.installId,
          name: want.name || have.name,
          message: `${have.name || want.installId} ${want.version} is required but the package is no longer available.`,
        });
      } else {
        restoreVersion.push({ installId: want.installId, name: have.name, from: have.version, to: want.version });
      }
    }
    if (want.enabled && have.enabled === false) enable.push({ installId: want.installId, name: have.name });
    if (!want.enabled && have.enabled !== false) disable.push({ installId: want.installId, name: have.name });
  }

  for (const have of current.mods || []) {
    if (!targetMods.some((mod) => mod.installId === have.installId) && have.enabled !== false) {
      disable.push({ installId: have.installId, name: have.name });
    }
  }

  const configChanges = [];
  const externalConfigs = [];
  const currentConfigs = new Map((current.configs || []).map((row) => [row.destination, row]));
  for (const want of target.configs || []) {
    const have = currentConfigs.get(want.destination);
    if (!have) {
      configChanges.push(want);
      continue;
    }
    if (have.hash !== want.hash) {
      if (want.capturedHash && have.hash !== want.capturedHash && have.hash !== want.hash) {
        externalConfigs.push(want);
      } else {
        configChanges.push(want);
      }
    }
  }

  return {
    disable,
    enable,
    restoreVersion,
    missing,
    incomplete,
    configChanges,
    externalConfigs,
    complete: incomplete.length === 0,
  };
}

function operationsFromPlan(plan, target) {
  const ops = [];
  for (const row of plan.disable) ops.push({ type: "DISABLE", installId: row.installId, name: row.name });
  for (const row of plan.enable) ops.push({ type: "ENABLE", installId: row.installId, name: row.name });
  for (const row of plan.restoreVersion) {
    ops.push({ type: "RESTORE_VERSION", installId: row.installId, name: row.name, from: row.from, to: row.to });
  }
  for (const row of plan.configChanges) {
    ops.push({ type: "RESTORE_CONFIG", destination: row.destination, hash: row.hash, installId: row.installId });
  }
  return ops;
}

async function applyOperations(ops, ctx) {
  const done = [];
  try {
    for (let i = 0; i < ops.length; i += 1) {
      if (ctx.hooks && ctx.hooks.failAt === i) {
        throw new Error(`Simulated failure at operation ${i}`);
      }
      await applyOne(ops[i], ctx);
      done.push(ops[i]);
    }
  } catch (error) {
    for (const op of done.slice().reverse()) {
      try {
        await reverseOne(op, ctx);
      } catch {
        /* keep reversing */
      }
    }
    throw error;
  }
}

async function applyOne(op, ctx) {
  if (op.type === "DISABLE" || op.type === "ENABLE") {
    const enabled = op.type === "ENABLE";
    if (ctx.adapters && ctx.adapters.setEnabled) await ctx.adapters.setEnabled({ modId: op.installId, enabled });
    else await smartInstall.setEnabled({ modId: op.installId, dutyPath: ctx.dutyPath, dataDir: ctx.dataDir, enabled });
    return;
  }
  if (op.type === "RESTORE_CONFIG") {
    const abs = path.join(ctx.dutyPath, String(op.destination).split("/").join(path.sep));
    op._before = {
      exists: fs.existsSync(abs),
      bytes: fs.existsSync(abs) ? fs.readFileSync(abs) : null,
    };
    const bytes = readBlob(ctx.blobRoot, op.hash);
    if (!bytes) throw new ProfileError(CODES.PROFILE_INCOMPLETE, `Config snapshot missing for ${op.destination}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    return;
  }
  if (op.type === "RESTORE_VERSION") {
    if (ctx.adapters && ctx.adapters.restoreVersion) {
      await ctx.adapters.restoreVersion(op);
      return;
    }
    const archive = findVersionPayload(ctx, op.installId, op.to);
    if (!archive) throw new ProfileError(CODES.PROFILE_INCOMPLETE, `${op.name || op.installId} ${op.to} is required but the package is no longer available.`);
    const manifest = manifestStore.read(ctx.dataDir, op.installId);
    op._before = { version: manifest && manifest.version, manifest };
    restoreVersionFiles(ctx, op.installId, archive, op.to);
  }
}

async function reverseOne(op, ctx) {
  if (op.type === "DISABLE") {
    if (ctx.adapters && ctx.adapters.setEnabled) await ctx.adapters.setEnabled({ modId: op.installId, enabled: true });
    else await smartInstall.setEnabled({ modId: op.installId, dutyPath: ctx.dutyPath, dataDir: ctx.dataDir, enabled: true });
    return;
  }
  if (op.type === "ENABLE") {
    if (ctx.adapters && ctx.adapters.setEnabled) await ctx.adapters.setEnabled({ modId: op.installId, enabled: false });
    else await smartInstall.setEnabled({ modId: op.installId, dutyPath: ctx.dutyPath, dataDir: ctx.dataDir, enabled: false });
    return;
  }
  if (op.type === "RESTORE_CONFIG" && op._before) {
    const abs = path.join(ctx.dutyPath, String(op.destination).split("/").join(path.sep));
    if (!op._before.exists) {
      try {
        fs.rmSync(abs, { force: true });
      } catch {
        /* ignore */
      }
    } else {
      fs.writeFileSync(abs, op._before.bytes);
    }
    return;
  }
  if (op.type === "RESTORE_VERSION") {
    if (ctx.adapters && ctx.adapters.restoreVersionReverse) {
      await ctx.adapters.restoreVersionReverse(op);
      return;
    }
    if (op._before && op._before.manifest) manifestStore.write(ctx.dataDir, op._before.manifest);
  }
}

function findVersionPayload(ctx, installId, version) {
  const current = manifestStore.read(ctx.dataDir, installId);
  if (current && (current.version || "UNKNOWN") === version && fs.existsSync(payloadStore.storeRoot(ctx.dataDir, installId))) {
    return payloadStore.storeRoot(ctx.dataDir, installId);
  }
  const hinted = ctx.payloadLookup && ctx.payloadLookup(installId, version);
  if (hinted && fs.existsSync(hinted)) return hinted;
  if (ctx.payloadRoot) {
    const dest = path.join(ctx.payloadRoot, installId, String(version || "UNKNOWN"));
    if (fs.existsSync(dest)) return dest;
  }
  return "";
}

function restoreVersionFiles(ctx, installId, archiveRoot, version) {
  const manifest = manifestStore.read(ctx.dataDir, installId);
  if (!manifest) return;
  for (const file of manifest.files || []) {
    const from = path.join(archiveRoot, String(file.destination || "").split("/").join(path.sep));
    if (!fs.existsSync(from)) continue;
    const to = path.join(ctx.dutyPath, String(file.destination).split("/").join(path.sep));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    payloadStore.saveInstalledFile(ctx.dataDir, installId, file.destination, to);
  }
  manifestStore.write(ctx.dataDir, { ...manifest, version, updatedAt: new Date().toISOString() });
}

function folderSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else {
        try {
          total += fs.statSync(abs).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

module.exports = {
  atomicWrite,
  assertDutyTarget,
  assertGameIdle,
  captureEnvironment,
  captureManagedState,
  stateHash,
  planDiff,
  operationsFromPlan,
  applyOperations,
  collectConfigs,
  putBlob,
  readBlob,
  archivePayload,
  payloadAvailable,
  findVersionPayload,
  currentConfigHash,
  listManaged,
  folderSize,
};
