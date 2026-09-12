const { test } = require("node:test");
const assert = require("node:assert");
const { writeFile, makeFakeDuty, cleanup } = require("./helpers");
const launchguard = require("../src/services/launchguard");

test("Damage Tracker in Plugins is a known RPH dependency, not junk", () => {
  assert.equal(launchguard.isAllowedPluginRootName("DamageTrackingFramework.dll"), true);
  assert.equal(launchguard.isAllowedPluginRootName("DamageTrackerFramework.dll"), true);
  assert.equal(launchguard.isAllowedPluginRootName("CalloutPack.dll"), false);

  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPD First Response.dll", "LSPDFR");
  writeFile(duty, "plugins/DamageTrackingFramework.dll", "DTF");
  try {
    const row = launchguard.verifyLaunchIntegrity(duty, "").checks.find((c) => c.id === "plugins-clean");
    assert.ok(row && row.ok, row && row.detail);
  } finally {
    cleanup(duty);
  }
});
