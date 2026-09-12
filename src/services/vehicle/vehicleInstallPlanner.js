const { OP_STATUS, PATH_STATUS, TARGET_STATE, KINDS } = require("./vehicleTypes");
const { resolveAsset } = require("./archivePathResolver");
const { CODES } = require("../archive/archiveErrors");
const archive = require("../archive/gtaArchiveService");
const ownership = require("../archive/archiveOwnership");
const { selectVehicleInstallStrategy, ENCRYPTED_INSTALL_MESSAGE } = require("./installStrategies");

function capabilitiesOrDefault(caps) {
  return caps || archive.getCapabilities();
}

function lookupTarget({ dataDir, mockArchivePath, archiveName, entry }) {
  if (mockArchivePath && entry) {
    try {
      const inspect = archive.inspectEntry(dataDir, mockArchivePath, entry);
      if (inspect.status === "EXTERNALLY_MODIFIED") {
        return {
          state: TARGET_STATE.EXTERNALLY_MODIFIED,
          status: inspect.status,
          currentOwner: inspect.currentOwner,
          hash: inspect.hash,
        };
      }
      if (inspect.currentOwner && inspect.currentOwner !== ownership.VANILLA) {
        return {
          state: TARGET_STATE.MANAGED_MOD,
          status: inspect.status,
          currentOwner: inspect.currentOwner,
          hash: inspect.hash,
        };
      }
      if (inspect.exists) {
        return {
          state: TARGET_STATE.VANILLA,
          status: "OK",
          currentOwner: ownership.VANILLA,
          hash: inspect.hash,
        };
      }
    } catch (error) {
      if (error && error.code === CODES.REAL_ARCHIVE_BACKEND_NOT_AVAILABLE) {
        return { state: TARGET_STATE.UNKNOWN, error: error.code, currentOwner: null };
      }
    }
  }

  if (dataDir && archiveName && entry) {
    const rec = ownership.getRecord(ownership.loadOwnership(dataDir), archiveName, entry);
    if (rec && rec.currentOwner && rec.currentOwner !== ownership.VANILLA) {
      return { state: TARGET_STATE.MANAGED_MOD, currentOwner: rec.currentOwner, status: rec.status || "OK" };
    }
    if (rec && rec.currentOwner === ownership.VANILLA) {
      return { state: TARGET_STATE.VANILLA, currentOwner: ownership.VANILLA, status: rec.status || "OK" };
    }
  }

  return { state: TARGET_STATE.UNKNOWN, currentOwner: null, status: "UNKNOWN" };
}

function operationStatus(resolved, target) {
  if (target.state === TARGET_STATE.EXTERNALLY_MODIFIED) return OP_STATUS.CONFLICT;
  if (resolved.status === PATH_STATUS.UNKNOWN) return OP_STATUS.UNKNOWN_TARGET;
  if (resolved.status === PATH_STATUS.AMBIGUOUS) return OP_STATUS.AMBIGUOUS_TARGET;
  if (resolved.status === PATH_STATUS.UNSUPPORTED) return OP_STATUS.UNSUPPORTED;
  if (target.currentOwner && target.currentOwner !== ownership.VANILLA) return OP_STATUS.CONFLICT;
  if (resolved.status === PATH_STATUS.VERIFIED || resolved.status === PATH_STATUS.DISCOVERED) return OP_STATUS.READY;
  return OP_STATUS.UNSUPPORTED;
}

function planVehicleInstall({
  analysis,
  pathMap,
  archiveIndex,
  discoverOptions,
  dataDir = "",
  mockArchivePath = "",
  capabilities,
  dutyPath = "",
  officialPath = "",
  layer = null,
} = {}) {
  const caps = capabilitiesOrDefault(capabilities);
  const strategy = selectVehicleInstallStrategy({
    analysis,
    dutyPath,
    officialPath,
    targetPath: dutyPath,
    archiveCapabilities: caps,
    injected: layer,
  });
  const groups = (analysis && analysis.groups) || [];
  const operations = [];
  const ownershipConflicts = [];

  const addonOnly = analysis && analysis.kind === KINDS.ADDON_VEHICLE;

  if (addonOnly) {
    return {
      mode: "DRY_RUN",
      applied: false,
      vehicleType: analysis.kind,
      slot: groups[0] ? groups[0].slot : "",
      slots: groups.map((g) => g.slot),
      archiveOperations: [],
      capability: "UNSUPPORTED",
      capabilityReason: ENCRYPTED_INSTALL_MESSAGE,
      archiveRequired: true,
      strategy: strategy.strategy,
      backend: strategy.backend,
      strategyReason: strategy.reason,
      addon: {
        detected: true,
        dlcPackage: inferDlcName(analysis),
        requiredFutureOperations: ["install DLC package", "update dlclist.xml"],
      },
      ownershipConflicts: [],
    };
  }

  for (const group of groups) {
    for (const role of ["model", "highDetailModel", "texture"]) {
      const asset = group[role];
      if (!asset) continue;
      const resolved = resolveAsset(group.slot, asset.base, { pathMap, archiveIndex, discoverOptions });
      const target = lookupTarget({
        dataDir,
        mockArchivePath,
        archiveName: resolved.archive,
        entry: resolved.entry,
      });
      const status = operationStatus(resolved, target);
      const op = {
        action: "REPLACE",
        archive: resolved.archive,
        entry: resolved.entry,
        source: asset.rel,
        slot: group.slot,
        role,
        pathStatus: resolved.status,
        status,
        currentState: target.state,
        currentOwner: target.currentOwner,
      };
      if (status === OP_STATUS.CONFLICT && target.currentOwner && target.currentOwner !== ownership.VANILLA) {
        ownershipConflicts.push({
          archive: resolved.archive,
          entry: resolved.entry,
          currentOwner: target.currentOwner,
          state: target.state,
          message:
            target.state === TARGET_STATE.EXTERNALLY_MODIFIED
              ? "Target was modified outside the manager. It will not be replaced silently."
              : `CURRENT OWNER: ${target.currentOwner}. Installing this package would replace it.`,
        });
      }
      operations.push(op);
    }
  }

  return {
    mode: "DRY_RUN",
    applied: false,
    vehicleType: analysis.kind,
    slot: groups.length === 1 ? groups[0].slot : "",
    slots: groups.map((g) => g.slot),
    archiveOperations: operations,
    capability: caps.write === true && caps.writeEnabled === true ? "READY" : "UNSUPPORTED",
    capabilityReason: ENCRYPTED_INSTALL_MESSAGE,
    archiveRequired: true,
    strategy: strategy.strategy,
    backend: strategy.backend,
    strategyReason: strategy.reason,
    ownershipConflicts,
  };
}

function inferDlcName(analysis) {
  const clue = (((analysis.classification || {}).addon || {}).clues || [])[0] || "";
  const pack = String(clue).match(/dlcpacks\/([^/]+)/i);
  if (pack) return pack[1];
  const files = (analysis.files || []).map((f) => String(f.rel || f));
  for (const rel of files) {
    const hit = rel.replace(/\\/g, "/").match(/dlcpacks\/([^/]+)/i);
    if (hit) return hit[1];
  }
  return "";
}

module.exports = { planVehicleInstall, lookupTarget };
