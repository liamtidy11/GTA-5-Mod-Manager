// Phase 3D: dry-run install-backend selection.
// No strategy writes official archives, Online, or encrypted RPFs.
// Production flags stay off until a licence-clear Enhanced overlay exists.

const fs = require("fs");
const path = require("path");
const { ENABLE_NATIVE_ARCHIVE_WRITES } = require("../archive/archiveFlags");

const INSTALL_BACKENDS = {
  FILESYSTEM: "FILESYSTEM",
  CUSTOM_DLC: "CUSTOM_DLC",
  RUNTIME_OVERRIDE: "RUNTIME_OVERRIDE",
  RPF_ARCHIVE: "RPF_ARCHIVE",
  UNSUPPORTED: "UNSUPPORTED",
};

const VEHICLE_STRATEGIES = {
  DIRECT_FILESYSTEM: "DIRECT_FILESYSTEM",
  CUSTOM_DLC_LAYER: "CUSTOM_DLC_LAYER",
  RUNTIME_OVERRIDE: "RUNTIME_OVERRIDE",
  NATIVE_ARCHIVE: "NATIVE_ARCHIVE",
  UNSUPPORTED: "UNSUPPORTED",
};

const ENABLE_CUSTOM_DLC_LAYER = false;
const ENABLE_RUNTIME_OVERRIDE = false;

const ENCRYPTED_INSTALL_MESSAGE =
  "This mod type is recognized, but this build cannot yet install encrypted archive modifications automatically.";

const OVERLAY_MARKERS = [
  { id: "openiv", file: "OpenIV.asi", licence: "proprietary", decision: "REJECTED_FOR_LICENSING" },
  { id: "openrpf", file: "OpenRPF.asi", licence: "GPL / no binary redistribution", decision: "REJECTED_FOR_LICENSING" },
  { id: "rageopenv", file: "RageOpenV.asi", licence: "GPL-3.0 / redistribution restricted", decision: "REJECTED_FOR_LICENSING" },
  { id: "lml", file: "lml.asi", licence: "LICENCE_UNCLEAR", decision: "REJECTED_FOR_LICENSING" },
  { id: "simple-mods-loader", file: "SimpleModsLoader.asi", licence: "LICENCE_UNCLEAR", decision: "REJECTED_FOR_LICENSING" },
];

function underRoot(targetPath, root) {
  if (!targetPath || !root) return false;
  const resolved = path.resolve(targetPath).toLowerCase();
  const base = path.resolve(root).toLowerCase();
  return resolved === base || resolved.startsWith(`${base}\\`) || resolved.startsWith(`${base}/`);
}

function rejectOnlineTarget(targetPath, officialPath) {
  if (officialPath && targetPath && underRoot(targetPath, officialPath)) {
    return {
      rejected: true,
      code: "ONLINE_TARGET_REJECTED",
      reason: "Archive and overlay installs are Duty-only. The Online folder is never a target.",
    };
  }
  return { rejected: false };
}

function detectOverlayPresence(dutyPath) {
  const detected = [];
  if (!dutyPath) return detected;
  for (const marker of OVERLAY_MARKERS) {
    const abs = path.join(dutyPath, marker.file);
    if (fs.existsSync(abs)) {
      detected.push({ ...marker, path: abs, present: true });
    }
  }
  return detected;
}

function layerFlags(overrides = {}) {
  return {
    enableCustomDlc: overrides.enableCustomDlc === true ? true : ENABLE_CUSTOM_DLC_LAYER,
    enableRuntimeOverride: overrides.enableRuntimeOverride === true ? true : ENABLE_RUNTIME_OVERRIDE,
    enableNativeArchive: overrides.enableNativeArchive === true ? true : ENABLE_NATIVE_ARCHIVE_WRITES === true,
  };
}

function assessInstallBackends(options = {}) {
  const flags = layerFlags(options.flags);
  const injected = options.injected || {};
  const overlays = detectOverlayPresence(options.dutyPath);
  const unlicensedPresent = overlays.filter((row) => row.decision === "REJECTED_FOR_LICENSING");

  const customDlc = {
    backend: INSTALL_BACKENDS.CUSTOM_DLC,
    available: injected.customDlcAvailable === true,
    licensed: injected.customDlcLicensed === true,
    enabled: flags.enableCustomDlc,
    dutyOnly: true,
    modifiesOfficialArchives: false,
    reason:
      injected.customDlcAvailable === true && injected.customDlcLicensed === true
        ? "Test-injected licensed custom DLC layer."
        : "No commercially redistributable Enhanced DLC overlay is enabled in this build.",
  };

  const runtimeOverride = {
    backend: INSTALL_BACKENDS.RUNTIME_OVERRIDE,
    available: injected.runtimeOverrideAvailable === true,
    licensed: injected.runtimeOverrideLicensed === true,
    enabled: flags.enableRuntimeOverride,
    detectedLoaders: overlays.map((row) => row.id),
    unlicensedLoaders: unlicensedPresent.map((row) => row.id),
    dutyOnly: true,
    modifiesOfficialArchives: false,
    reason:
      injected.runtimeOverrideAvailable === true && injected.runtimeOverrideLicensed === true
        ? "Test-injected licensed runtime override."
        : unlicensedPresent.length
          ? "An overlay ASI is present, but it is not licensed for this product to use or bundle."
          : "No licence-clear Enhanced runtime overlay is available.",
  };

  const nativeArchive = {
    backend: INSTALL_BACKENDS.RPF_ARCHIVE,
    available: Boolean(options.archiveCapabilities && options.archiveCapabilities.realGtaArchives),
    writeEnabled: flags.enableNativeArchive,
    licensed: false,
    dutyOnly: true,
    modifiesOfficialArchives: true,
    reason: "Encrypted official RPF writes are not enabled and have no lawful key source for distribution.",
  };

  const filesystem = {
    backend: INSTALL_BACKENDS.FILESYSTEM,
    available: true,
    licensed: true,
    enabled: true,
    dutyOnly: true,
    vehicleAssets: false,
    reason: "Filesystem installs cover plugins and configs only. Loose .yft/.ytd are not loaded by Enhanced.",
  };

  return {
    filesystem,
    customDlc,
    runtimeOverride,
    nativeArchive,
    overlays,
    writeEnabled: false,
    preferredFuture: INSTALL_BACKENDS.CUSTOM_DLC,
  };
}

function selectable(layer) {
  return layer && layer.available === true && layer.licensed === true;
}

function selectVehicleInstallStrategy(options = {}) {
  const online = rejectOnlineTarget(options.targetPath, options.officialPath);
  if (online.rejected) {
    return {
      strategy: VEHICLE_STRATEGIES.UNSUPPORTED,
      backend: INSTALL_BACKENDS.UNSUPPORTED,
      status: "UNSUPPORTED",
      applied: false,
      code: online.code,
      reason: online.reason,
    };
  }

  if (options.requestStrategy === VEHICLE_STRATEGIES.RUNTIME_OVERRIDE && options.injected && options.injected.runtimeOverrideLicensed !== true) {
    return {
      strategy: VEHICLE_STRATEGIES.UNSUPPORTED,
      backend: INSTALL_BACKENDS.UNSUPPORTED,
      status: "UNSUPPORTED",
      applied: false,
      code: "UNLICENSED_STRATEGY_REJECTED",
      reason: "Unlicensed or licence-unclear overlay strategies are never selected.",
    };
  }

  const layers = assessInstallBackends(options);

  if (selectable(layers.customDlc)) {
    return {
      strategy: VEHICLE_STRATEGIES.CUSTOM_DLC_LAYER,
      backend: INSTALL_BACKENDS.CUSTOM_DLC,
      status: "UNSUPPORTED",
      applied: false,
      reason: "Preferred safe layer selected in dry-run only. No game files were written.",
    };
  }
  if (selectable(layers.runtimeOverride)) {
    return {
      strategy: VEHICLE_STRATEGIES.RUNTIME_OVERRIDE,
      backend: INSTALL_BACKENDS.RUNTIME_OVERRIDE,
      status: "UNSUPPORTED",
      applied: false,
      reason: "Runtime override selected in dry-run only. No game files were written.",
    };
  }
  if (layers.nativeArchive.writeEnabled === true && options.archiveCapabilities && options.archiveCapabilities.write === true) {
    return {
      strategy: VEHICLE_STRATEGIES.NATIVE_ARCHIVE,
      backend: INSTALL_BACKENDS.RPF_ARCHIVE,
      status: "UNSUPPORTED",
      applied: false,
      reason: "Native archive writes remain disabled.",
    };
  }
  if (options.xmlRemapOnly === true) {
    return {
      strategy: VEHICLE_STRATEGIES.DIRECT_FILESYSTEM,
      backend: INSTALL_BACKENDS.FILESYSTEM,
      status: "UNSUPPORTED",
      applied: false,
      reason: "LSPDFR XML remapping cannot load vehicle models by itself.",
    };
  }

  return {
    strategy: VEHICLE_STRATEGIES.UNSUPPORTED,
    backend: INSTALL_BACKENDS.UNSUPPORTED,
    status: "UNSUPPORTED",
    applied: false,
    code: "NO_SAFE_ENHANCED_MOD_LAYER",
    reason: ENCRYPTED_INSTALL_MESSAGE,
  };
}

module.exports = {
  INSTALL_BACKENDS,
  VEHICLE_STRATEGIES,
  ENABLE_CUSTOM_DLC_LAYER,
  ENABLE_RUNTIME_OVERRIDE,
  ENCRYPTED_INSTALL_MESSAGE,
  OVERLAY_MARKERS,
  rejectOnlineTarget,
  detectOverlayPresence,
  assessInstallBackends,
  selectVehicleInstallStrategy,
};
