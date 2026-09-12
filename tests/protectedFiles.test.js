const { test } = require("node:test");
const assert = require("node:assert");
const protectedFiles = require("../src/services/protectedFiles");

test("XInput1_4.dll is protected and a huge shrink is high risk", () => {
  const result = protectedFiles.evaluate({
    destRel: "XInput1_4.dll",
    incomingSize: 6000,
    existingSize: 2_000_000,
  });
  assert.equal(result.skip, true);
  assert.equal(result.severity, "HIGH_RISK");
  assert.match(result.reason, /much smaller/i);
});

test("startup.rphs is a critical protected file (skipped, not overwritten)", () => {
  const result = protectedFiles.evaluate({ destRel: "startup.rphs" });
  assert.equal(result.skip, true);
  assert.equal(result.level, "critical");
  assert.equal(result.kind, "protected");
});

test("the LSPDFR plugin path is protected by exact path match", () => {
  const result = protectedFiles.evaluate({ destRel: "plugins/LSPD First Response.dll" });
  assert.equal(result.skip, true);
  assert.equal(result.severity, "HIGH_RISK");
});

test("Newtonsoft.Json.dll is blocked incoming and never installed", () => {
  const result = protectedFiles.evaluate({ destRel: "plugins/LSPDFR/Newtonsoft.Json.dll" });
  assert.equal(result.skip, true);
  assert.equal(result.kind, "blocked-incoming");
});

test("ScriptHookV.dll is treated as risky and skipped", () => {
  const result = protectedFiles.evaluate({ destRel: "ScriptHookV.dll" });
  assert.equal(result.skip, true);
  assert.equal(result.severity, "HIGH_RISK");
  assert.equal(result.kind, "risky-incoming");
});

test("a normal plugin file is not protected", () => {
  const result = protectedFiles.evaluate({ destRel: "plugins/LSPDFR/MyCallout.dll" });
  assert.equal(result.skip, false);
  assert.equal(result.severity, "NONE");
});
