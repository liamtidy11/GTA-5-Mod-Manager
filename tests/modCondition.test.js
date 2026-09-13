const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { tmpDir, writeFile, cleanup } = require("./helpers");
const modCondition = require("../src/services/knowledge/modCondition");
const { buildPrompt } = require("../src/services/knowledge/conditionBrief");
const modHealthV2 = require("../src/services/modHealthV2");

function dutyWith(files) {
  const duty = tmpDir("condition-duty-");
  fs.writeFileSync(path.join(duty, "GTA5_Enhanced.exe"), "stub");
  for (const file of files) writeFile(duty, file, "x");
  return duty;
}

test("folder plugin waits for in-game log proof even when files are present", () => {
  const duty = dutyWith(["plugins/LSPDFR/GrammarPolice.dll"]);
  const row = modCondition.evaluateOne(
    {
      id: "gp",
      name: "Grammar Police",
      enabled: true,
      files: ["plugins/LSPDFR/GrammarPolice.dll"],
    },
    { source: "FOLDER", dutyPath: duty }
  );
  assert.equal(row.status, "WARNING");
  assert.equal(row.lamp, "warn");
  assert.ok(row.reasons.some((line) => /waiting for runtime/i.test(line)));
  cleanup(duty);
});

test("folder plugin turns green after its own Duty load line", () => {
  const duty = dutyWith(["plugins/LSPDFR/GrammarPolice.dll"]);
  fs.writeFileSync(path.join(duty, "RagePluginHook.log"), "Creating plugin: GrammarPolice.Main\n");
  const row = modCondition.evaluateOne(
    {
      id: "gp",
      name: "Grammar Police",
      enabled: true,
      files: ["plugins/LSPDFR/GrammarPolice.dll"],
    },
    { source: "FOLDER", dutyPath: duty }
  );
  assert.equal(row.status, "HEALTHY");
  assert.equal(row.lamp, "ok");
  cleanup(duty);
});

test("disabled folder pack is grey, not red", () => {
  const duty = dutyWith(["plugins/LSPDFR/GrammarPolice.dll"]);
  const lamps = modCondition.attachLamps(
    [{ id: "gp", name: "Grammar Police", enabled: false, files: ["plugins/LSPDFR/GrammarPolice.dll"] }],
    { source: "FOLDER", dutyPath: duty }
  );
  assert.equal(lamps[0].lamp, "grey");
  assert.equal(lamps[0].healthStatus, "DISABLED");
  cleanup(duty);
});

test("missing tracked files turn the lamp red", () => {
  const duty = dutyWith([]);
  const row = modCondition.evaluateOne(
    {
      id: "gone",
      name: "Missing Pack",
      enabled: true,
      files: ["plugins/LSPDFR/Missing.dll"],
    },
    { source: "FOLDER", dutyPath: duty }
  );
  assert.equal(row.status, "BROKEN");
  assert.equal(row.lamp, "bad");
  cleanup(duty);
});

test("partial missing files are yellow, not red", () => {
  const duty = dutyWith(["plugins/LSPDFR/One.dll"]);
  const row = modCondition.evaluateOne(
    {
      id: "half",
      name: "Half Pack",
      enabled: true,
      files: ["plugins/LSPDFR/One.dll", "plugins/LSPDFR/Two.dll"],
    },
    { source: "FOLDER", dutyPath: duty }
  );
  assert.equal(row.status, "WARNING");
  assert.equal(row.lamp, "warn");
  cleanup(duty);
});

test("Grammar Police folder pack turns red when the Duty log says a dependency is missing", () => {
  const duty = dutyWith(["plugins/LSPDFR/GrammarPolice.dll"]);
  fs.writeFileSync(
    path.join(duty, "RagePluginHook.log"),
    [
      "Creating plugin: GrammarPolice.Main",
      "GrammarPolice dependency CalloutInterfaceAPI.dll is not available.",
    ].join("\n")
  );
  const row = modCondition.evaluateOne(
    {
      id: "gp",
      name: "Grammar Police",
      enabled: true,
      kinds: ["lspdfr"],
      files: ["plugins/LSPDFR/GrammarPolice.dll"],
    },
    { source: "FOLDER", dutyPath: duty }
  );
  assert.equal(row.status, "BROKEN");
  assert.equal(row.lamp, "bad");
  assert.match(row.reasons.join(" "), /not available/i);
  cleanup(duty);
});

test("a failed LSPDFR log does not paint unrelated folder packs red", () => {
  const duty = dutyWith(["plugins/LSPDFR/CalloutInterface.dll"]);
  fs.writeFileSync(
    path.join(duty, "RagePluginHook.log"),
    "Failed to load plugin LSPD First Response.dll\n"
  );
  const row = modCondition.evaluateOne(
    {
      id: "ci",
      name: "Callout Interface",
      enabled: true,
      kinds: ["lspdfr"],
      files: ["plugins/LSPDFR/CalloutInterface.dll"],
    },
    { source: "FOLDER", dutyPath: duty }
  );
  assert.notEqual(row.status, "BROKEN");
  assert.equal(row.lamp, "warn");
  assert.ok(row.reasons.some((line) => /waiting for runtime/i.test(line)));
  cleanup(duty);
});

test("vehicle files present stay yellow because Enhanced archives may not load", () => {
  const duty = dutyWith(["mods/update/x64/dlcpacks/police/dlc.rpf"]);
  const row = modCondition.evaluateOne(
    {
      id: "car",
      name: "Police Car",
      enabled: true,
      kinds: ["vehicle"],
      files: ["mods/update/x64/dlcpacks/police/dlc.rpf"],
    },
    { source: "FOLDER", dutyPath: duty }
  );
  assert.equal(row.status, "WARNING");
  assert.match(row.reasons.join(" "), /Enhanced archives/i);
  cleanup(duty);
});

test("analyzeAll scores folder and Smart Install mods together", () => {
  const duty = dutyWith(["plugins/LSPDFR/Ok.dll"]);
  const result = modCondition.analyzeAll({
    dutyPath: duty,
    folderMods: [{ id: "ok", name: "Ok Pack", enabled: true, files: ["plugins/LSPDFR/Ok.dll"] }],
    smartMods: [{ id: "smart", name: "Unknown Plugin", enabled: true, compatibilityStatus: "UNKNOWN", files: [{ destination: "plugins/LSPDFR/Ok.dll" }] }],
  });
  assert.equal(result.folder[0].status, "WARNING");
  assert.equal(result.smart[0].status, "WARNING");
  assert.deepEqual(result.todos, []);
  assert.equal(result.advice[0], "Nothing you need to do.");
  assert.equal(result.summary.length, 1);
  assert.equal(result.summary[0].source, "SMART");
  cleanup(duty);
});

test("Smart Install plugin waits for runtime verification", () => {
  const row = modHealthV2.evaluateModHealth(
    { id: "m", enabled: true, compatibilityStatus: "UNKNOWN", files: [{ destination: "plugins/LSPDFR/M.dll" }] },
    {}
  );
  assert.equal(row.status, "WARNING");
  assert.ok(row.reasons.some((line) => /waiting for runtime/i.test(line)));
  const skipped = modHealthV2.evaluateModHealth(
    { id: "m", enabled: true, compatibilityStatus: "UNKNOWN" },
    { ignoreUnknownCompatibility: true }
  );
  assert.equal(skipped.status, "HEALTHY");
});

test("condition brief prompt only restates supplied lamps", () => {
  const prompt = buildPrompt({
    counts: { HEALTHY: 1, WARNING: 1, BROKEN: 0, DISABLED: 0 },
    advice: ["One yellow lamp needs a look."],
    summary: [{ status: "WARNING", source: "SMART", name: "Unknown Plugin", reasons: ["Compatibility is unknown."] }],
  });
  assert.match(prompt, /Only use the supplied lamp results/);
  assert.match(prompt, /Unknown Plugin/);
  assert.doesNotMatch(prompt, /Cursor can/);
});
