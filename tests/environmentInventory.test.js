const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const { tmpDir, writeFile, makeFakeDuty, cleanup } = require("./helpers");
const registry = require("../src/services/registry");
const inventory = require("../src/services/environmentInventory");

const QUIET = {
  overlayStatus: () => ({ nvidiaOverlay: false, nvidiaShare: false }),
  cortexRunning: () => false,
};

function snap(duty, extra = {}) {
  return inventory.getInventory({ dutyPath: duty, deps: QUIET, ...extra });
}

function healthyDuty() {
  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPD First Response.dll", "LSPDFR");
  writeFile(duty, "RagePluginHook.exe", "RPH");
  writeFile(duty, "DirectStorageFix.asi", "DS");
  writeFile(duty, "HeapAdjuster.asi", "HEAP");
  writeFile(duty, "PackfileLimitAdjusterEnhanced.asi", "PACK");
  writeFile(duty, "XInput1_4.dll", Buffer.alloc(200000, 1));
  writeFile(duty, "startup.rphs", 'LoadPlugin "LSPD First Response.dll"\n');
  return duty;
}

beforeEach(() => {
  inventory.invalidate();
});

test("healthy environment recognizes Enhanced, LSPDFR, RPH, and core ASI", () => {
  const duty = healthyDuty();
  try {
    const inv = snap(duty);
    assert.equal(inv.gta.edition, "Enhanced");
    assert.equal(inv.gta.installed, true);
    assert.equal(inv.gta.version, "UNKNOWN");
    assert.equal(inv.lspdfr.installed, true);
    assert.equal(inv.lspdfr.enabled, true);
    assert.equal(inv.lspdfr.state, "INSTALLED");
    assert.equal(inv.ragePluginHook.installed, true);
    assert.equal(inv.ragePluginHook.state, "INSTALLED");
    assert.equal(inventory.findComponent(inv, "directstoragefix").state, "INSTALLED");
    assert.equal(inventory.findComponent(inv, "heapadjuster").state, "INSTALLED");
    assert.equal(inventory.findComponent(inv, "packfile-limit-adjuster").state, "INSTALLED");
    assert.equal(inventory.findComponent(inv, "scripthookv").state, "MISSING");
    assert.equal(inv.disabledComponents.length, 0);
    assert.ok(inv.protectedFiles.some((p) => p.match === "xinput1_4.dll"));
  } finally {
    cleanup(duty);
  }
});

test("missing LSPDFR is reported as MISSING", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "RagePluginHook.exe", "RPH");
  try {
    const inv = snap(duty);
    assert.equal(inv.lspdfr.installed, false);
    assert.equal(inv.lspdfr.state, "MISSING");
    assert.equal(inv.lspdfr.version, "UNKNOWN");
  } finally {
    cleanup(duty);
  }
});

test("missing RPH is reported as MISSING", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPD First Response.dll", "LSPDFR");
  try {
    const inv = snap(duty);
    assert.equal(inv.ragePluginHook.installed, false);
    assert.equal(inv.ragePluginHook.state, "MISSING");
  } finally {
    cleanup(duty);
  }
});

test("parked Script Hook V is DISABLED/PARKED, not missing", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPD First Response.dll", "LSPDFR");
  writeFile(duty, ".tactix/disabled/scripthookv-test/ScriptHookV.dll", "PARKED");
  registry.add(duty, {
    id: "scripthookv-test",
    name: "ScriptHookV",
    enabled: false,
    files: ["ScriptHookV.dll"],
  });
  try {
    const inv = snap(duty);
    const shv = inventory.findComponent(inv, "scripthookv");
    assert.equal(shv.installed, true);
    assert.equal(shv.enabled, false);
    assert.equal(shv.state, "PARKED");
    assert.equal(shv.version, "UNKNOWN");
    assert.ok(inv.disabledComponents.some((c) => c.id === "scripthookv"));
    assert.equal(inventory.findComponent(inv, "scripthookvdotnet").state, "MISSING");
  } finally {
    cleanup(duty);
  }
});

test("parked Script Hook V .NET is PARKED, not missing", () => {
  const duty = makeFakeDuty();
  writeFile(duty, ".tactix/disabled/shvdn-test/ScriptHookVDotNet.asi", "PARKED");
  writeFile(duty, ".tactix/disabled/shvdn-test/scripts/ScriptHookVDotNet3.dll", "PARKED");
  registry.add(duty, {
    id: "shvdn-test",
    name: "ScriptHookVDotNet",
    enabled: false,
    files: ["ScriptHookVDotNet.asi", "scripts\\ScriptHookVDotNet3.dll"],
  });
  try {
    const inv = snap(duty);
    const shvdn = inventory.findComponent(inv, "scripthookvdotnet");
    assert.equal(shvdn.installed, true);
    assert.equal(shvdn.enabled, false);
    assert.equal(shvdn.state, "PARKED");
    assert.ok(inv.disabledComponents.some((c) => c.id === "scripthookvdotnet"));
  } finally {
    cleanup(duty);
  }
});

test("live Script Hook V is INSTALLED and enabled", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "ScriptHookV.dll", "LIVE");
  try {
    const inv = snap(duty);
    const shv = inventory.findComponent(inv, "scripthookv");
    assert.equal(shv.state, "INSTALLED");
    assert.equal(shv.enabled, true);
    assert.equal(inv.disabledComponents.some((c) => c.id === "scripthookv"), false);
  } finally {
    cleanup(duty);
  }
});

test("frameworks and plugin DLLs are listed from targeted folders only", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPD First Response.dll", "LSPDFR");
  writeFile(duty, "plugins/LSPDFR/RAGENativeUI.dll", "UI");
  writeFile(duty, "plugins/LSPDFR/MyCallout.dll", "PLUGIN");
  writeFile(duty, "update/x64/noise.bin", "DO-NOT-SCAN");
  try {
    const inv = snap(duty);
    assert.ok(inv.frameworks.some((f) => f.id === "ragenativeui"));
    assert.ok(inv.plugins.some((p) => p.file === "plugins/LSPDFR/MyCallout.dll"));
    assert.equal(inv.plugins.some((p) => /LSPD First Response/i.test(p.name)), false);
  } finally {
    cleanup(duty);
  }
});

test("inventory cache is reused until invalidate / refreshInventory", () => {
  const duty = healthyDuty();
  try {
    const first = snap(duty);
    writeFile(duty, "plugins/LSPDFR/Later.dll", "NEW");
    const cached = snap(duty);
    assert.equal(cached.cached, true);
    assert.equal(cached.scannedAt, first.scannedAt);
    assert.equal(cached.plugins.some((p) => p.name === "Later.dll"), false);

    inventory.invalidate({ dutyPath: duty });
    const after = snap(duty);
    assert.equal(after.cached, false);
    assert.ok(after.plugins.some((p) => p.name === "Later.dll"));

    writeFile(duty, "plugins/LSPDFR/Again.dll", "NEW2");
    const refreshed = inventory.refreshInventory({ dutyPath: duty, deps: QUIET });
    assert.ok(refreshed.plugins.some((p) => p.name === "Again.dll"));
  } finally {
    cleanup(duty);
  }
});

test("unknown versions stay UNKNOWN and overlays stay process-sourced", () => {
  const duty = healthyDuty();
  try {
    const inv = inventory.getInventory({
      dutyPath: duty,
      deps: {
        overlayStatus: () => ({ nvidiaOverlay: true, nvidiaShare: false }),
        cortexRunning: () => true,
      },
    });
    assert.equal(inv.gta.version, "UNKNOWN");
    assert.equal(inv.lspdfr.version, "UNKNOWN");
    assert.equal(inv.ragePluginHook.version, "UNKNOWN");
    const nvidia = inv.overlays.find((o) => o.name === "NVIDIA Overlay");
    const cortex = inv.overlays.find((o) => o.name === "Razer Cortex");
    assert.equal(nvidia.running, true);
    assert.equal(nvidia.source, "PROCESS");
    assert.equal(cortex.running, true);
  } finally {
    cleanup(duty);
  }
});

test("installer disable invalidates the inventory cache", async () => {
  const duty = healthyDuty();
  writeFile(duty, "ScriptHookV.dll", "LIVE");
  registry.add(duty, { id: "shv", name: "SHV", enabled: true, files: ["ScriptHookV.dll"] });
  try {
    const first = snap(duty);
    assert.equal(inventory.findComponent(first, "scripthookv").state, "INSTALLED");
    const installer = require("../src/services/installer");
    await installer.setEnabled(duty, "", "shv", false);
    const after = snap(duty);
    assert.equal(after.cached, false);
    assert.equal(inventory.findComponent(after, "scripthookv").state, "PARKED");
    assert.equal(inventory.findComponent(after, "scripthookv").enabled, false);
  } finally {
    cleanup(duty);
  }
});

test("no duty path yields MISSING core components without throwing", () => {
  const inv = inventory.getInventory({ deps: QUIET });
  assert.equal(inv.gta.edition, "UNKNOWN");
  assert.equal(inv.lspdfr.state, "MISSING");
  assert.equal(inv.ragePluginHook.state, "MISSING");
});

test("folder without Enhanced exe is not reported as Enhanced", () => {
  const duty = tmpDir("legacy-");
  writeFile(duty, "GTA5.exe", "legacy");
  try {
    const inv = snap(duty);
    assert.equal(inv.gta.edition, "UNKNOWN");
    assert.equal(inv.gta.installed, false);
    assert.equal(inv.gta.state, "MISSING");
  } finally {
    cleanup(duty);
  }
});
