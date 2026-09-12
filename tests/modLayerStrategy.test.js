const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  INSTALL_BACKENDS,
  VEHICLE_STRATEGIES,
  ENABLE_CUSTOM_DLC_LAYER,
  ENABLE_RUNTIME_OVERRIDE,
  rejectOnlineTarget,
  selectVehicleInstallStrategy,
} = require("../src/services/vehicle/installStrategies");
const { planVehicleInstall } = require("../src/services/vehicle/vehicleInstallPlanner");
const { ENABLE_NATIVE_ARCHIVE_WRITES } = require("../src/services/archive/archiveFlags");

test("archive strategy unavailable and default fallback is UNSUPPORTED", () => {
  assert.equal(ENABLE_NATIVE_ARCHIVE_WRITES, false);
  assert.equal(ENABLE_CUSTOM_DLC_LAYER, false);
  assert.equal(ENABLE_RUNTIME_OVERRIDE, false);
  const selected = selectVehicleInstallStrategy({
    dutyPath: "C:\\duty",
    officialPath: "C:\\online",
    targetPath: "C:\\duty",
    archiveCapabilities: { realGtaArchives: true, write: false, writeEnabled: false },
  });
  assert.equal(selected.strategy, VEHICLE_STRATEGIES.UNSUPPORTED);
  assert.equal(selected.backend, INSTALL_BACKENDS.UNSUPPORTED);
  assert.equal(selected.applied, false);
  assert.equal(selected.code, "NO_SAFE_ENHANCED_MOD_LAYER");
});

test("custom DLC strategy available is preferred over runtime override", () => {
  const selected = selectVehicleInstallStrategy({
    dutyPath: "C:\\duty",
    officialPath: "C:\\online",
    targetPath: "C:\\duty",
    injected: {
      customDlcAvailable: true,
      customDlcLicensed: true,
      runtimeOverrideAvailable: true,
      runtimeOverrideLicensed: true,
    },
  });
  assert.equal(selected.strategy, VEHICLE_STRATEGIES.CUSTOM_DLC_LAYER);
  assert.equal(selected.backend, INSTALL_BACKENDS.CUSTOM_DLC);
  assert.equal(selected.status, "UNSUPPORTED");
  assert.equal(selected.applied, false);
});

test("runtime override available when it is licensed", () => {
  const selected = selectVehicleInstallStrategy({
    dutyPath: "C:\\duty",
    officialPath: "C:\\online",
    targetPath: "C:\\duty",
    injected: { runtimeOverrideAvailable: true, runtimeOverrideLicensed: true },
  });
  assert.equal(selected.strategy, VEHICLE_STRATEGIES.RUNTIME_OVERRIDE);
  assert.equal(selected.applied, false);
  assert.equal(selected.status, "UNSUPPORTED");
});

test("unsafe or unlicensed strategy is rejected", () => {
  const selected = selectVehicleInstallStrategy({
    dutyPath: "C:\\duty",
    officialPath: "C:\\online",
    targetPath: "C:\\duty",
    requestStrategy: VEHICLE_STRATEGIES.RUNTIME_OVERRIDE,
    injected: { runtimeOverrideAvailable: true, runtimeOverrideLicensed: false },
  });
  assert.equal(selected.strategy, VEHICLE_STRATEGIES.UNSUPPORTED);
  assert.equal(selected.code, "UNLICENSED_STRATEGY_REJECTED");
});

test("Duty-only requirement and Online target rejected", () => {
  const online = "C:\\\\Steam\\\\Grand Theft Auto V Enhanced";
  const duty = "C:\\\\Duty\\\\Grand Theft Auto V Enhanced - LSPDFR";
  const hit = rejectOnlineTarget(`${online}\\\\update\\\\update.rpf`, online);
  assert.equal(hit.rejected, true);
  assert.equal(hit.code, "ONLINE_TARGET_REJECTED");
  const selected = selectVehicleInstallStrategy({
    officialPath: online,
    targetPath: `${online}\\\\x64a.rpf`,
  });
  assert.equal(selected.code, "ONLINE_TARGET_REJECTED");
  assert.equal(selected.strategy, VEHICLE_STRATEGIES.UNSUPPORTED);
  const dutyOk = rejectOnlineTarget(duty, online);
  assert.equal(dutyOk.rejected, false);
});

test("planner stays dry-run UNSUPPORTED even when a preferred layer is injected", () => {
  const plan = planVehicleInstall({
    analysis: {
      kind: "REPLACE_VEHICLE",
      groups: [{ slot: "police3", model: { base: "police3.yft", rel: "police3.yft" } }],
    },
    pathMap: { schemaVersion: 1, edition: "Enhanced", vehicleSlots: {} },
    dutyPath: "C:\\duty",
    officialPath: "C:\\online",
    layer: { customDlcAvailable: true, customDlcLicensed: true },
    capabilities: { write: false, writeEnabled: false, realGtaArchives: true },
  });
  assert.equal(plan.applied, false);
  assert.equal(plan.capability, "UNSUPPORTED");
  assert.equal(plan.strategy, VEHICLE_STRATEGIES.CUSTOM_DLC_LAYER);
  assert.equal(plan.archiveRequired, true);
});
