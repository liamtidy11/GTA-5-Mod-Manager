const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { tmpDir, writeFile, fileExists, cleanup } = require("./helpers");
const conditionFix = require("../src/services/knowledge/conditionFix");
const { saveInstalledFile } = require("../src/services/payloadStore");
const dutyLayoutFix = require("../src/services/knowledge/dutyLayoutFix");
const { repairManagedMod } = require("../src/services/smartRepair");

function dutyWith(files) {
  const duty = tmpDir("fix-duty-");
  fs.writeFileSync(path.join(duty, "GTA5_Enhanced.exe"), "stub");
  for (const file of files) writeFile(duty, file, "x");
  return duty;
}

test("Analyze next step for a missing plugin dependency is install that plugin", () => {
  const step = conditionFix.nextStep({
    name: "GrammarPolice-1.8.3.1 (2)",
    status: "BROKEN",
    reasons: ["GrammarPolice dependency CalloutInterfaceAPI.dll is not available."],
    runtime: {
      status: "FAILED",
      evidence: "LSPD First Response: GrammarPolice dependency CalloutInterfaceAPI.dll is not available.",
    },
  });
  assert.equal(step.needed, true);
  assert.match(step.do, /Install Callout Interface/i);
  assert.match(step.do, /Play LSPDFR/i);
});

test("Callout Interface is not told to install itself", () => {
  const step = conditionFix.nextStep({
    name: "CalloutInterface-1.4.1",
    status: "BROKEN",
    reasons: ["CalloutInterface dependency CalloutInterfaceAPI.dll is not available."],
    runtime: {
      status: "FAILED",
      evidence: "LSPD First Response: CalloutInterface dependency CalloutInterfaceAPI.dll is not available.",
    },
  });
  assert.equal(step.needed, true);
  assert.doesNotMatch(step.do, /Install Callout Interface/i);
  assert.match(step.do, /did not load/i);
});

test("a missing dependency already on disk is not an install todo", () => {
  const duty = dutyWith(["plugins/LSPDFR/CalloutInterface.dll", "plugins/LSPDFR/CalloutInterfaceAPI.dll"]);
  const step = conditionFix.nextStep(
    {
      name: "GrammarPolice-1.8.3.1 (2)",
      status: "BROKEN",
      runtime: {
        status: "FAILED",
        evidence: "LSPD First Response: GrammarPolice dependency CalloutInterfaceAPI.dll is not available.",
      },
    },
    null,
    { dutyPath: duty }
  );
  assert.equal(step.needed, true);
  assert.doesNotMatch(step.do, /Install Callout Interface/i);
  assert.match(step.do, /game exe/i);
  cleanup(duty);
});

test("CalloutInterface.dll alone does not count as the API already being installed", () => {
  const duty = dutyWith(["plugins/LSPDFR/CalloutInterface.dll"]);
  const step = conditionFix.nextStep(
    {
      name: "GrammarPolice-1.8.3.1 (2)",
      status: "BROKEN",
      runtime: {
        status: "FAILED",
        evidence: "LSPD First Response: GrammarPolice dependency CalloutInterfaceAPI.dll is not available.",
      },
    },
    null,
    { dutyPath: duty }
  );
  assert.equal(step.needed, true);
  assert.match(step.do, /Install Callout Interface/i);
  cleanup(duty);
});

test("missing Callout Interface libraries next to the exe can be healed", () => {
  const plan = conditionFix.planRow(
    {
      name: "CalloutInterface-1.4.1",
      status: "BROKEN",
      runtime: { status: "FAILED", evidence: "CalloutInterface dependency CalloutInterfaceAPI.dll is not available." },
    },
    { missingPluginLibraries: [{ name: "CalloutInterfaceAPI.dll" }, { name: "IPT.Common.dll" }] }
  );
  assert.equal(plan.fixable, true);
  assert.equal(plan.action, "HEAL_LAYOUT");
  assert.match(plan.reason, /CalloutInterfaceAPI\.dll/i);
  assert.match(plan.reason, /game exe/i);
});

test("missing plugin libraries can be healed before a failed session", () => {
  const plan = conditionFix.planRow(
    {
      name: "CalloutInterface-1.4.1",
      status: "WARNING",
      reasons: ["Installed. Waiting for runtime verification."],
    },
    { missingPluginLibraries: [{ name: "IPT.Common.dll" }] }
  );
  assert.equal(plan.fixable, true);
  assert.equal(plan.action, "HEAL_LAYOUT");
});

test("stray support DLLs plus a failed plugin can be healed", () => {
  const plan = conditionFix.planRow(
    {
      name: "CalloutInterface-1.4.1",
      status: "BROKEN",
      runtime: { status: "FAILED", evidence: "CalloutInterface dependency CalloutInterfaceAPI.dll is not available." },
    },
    { straySupportDlls: [{ rel: "plugins/LSPDFR/SlimDX.dll" }] }
  );
  assert.equal(plan.fixable, true);
  assert.equal(plan.action, "HEAL_LAYOUT");
  assert.match(plan.reason, /plugins\\LSPDFR/i);
});

test("waiting for runtime is not a correction todo", () => {
  const step = conditionFix.nextStep({
    name: "Future Plugin",
    status: "WARNING",
    reasons: ["Installed. Waiting for runtime verification."],
  });
  assert.equal(step.needed, false);
});

test("unknown compatibility is not auto-fixed", () => {
  const plan = conditionFix.planRow({
    status: "WARNING",
    source: "SMART",
    reasons: ["Compatibility with this Duty setup is unknown."],
    issues: [],
  });
  assert.equal(plan.fixable, false);
  assert.match(plan.reason, /cannot invent Enhanced support/i);
});

test("Enhanced archives are not auto-fixed", () => {
  const plan = conditionFix.planRow({
    status: "WARNING",
    source: "FOLDER",
    reasons: ["Files are present. Encrypted Enhanced archives still may not load."],
    issues: [{ code: "ARCHIVE_LIMIT" }],
  });
  assert.equal(plan.fixable, false);
  assert.match(plan.reason, /cannot be written/i);
});

test("missing Smart Install files with a stored copy can be repaired", () => {
  const plan = conditionFix.planRow(
    {
      status: "BROKEN",
      source: "SMART",
      reasons: ["All 1 tracked files are missing from the Duty folder."],
      issues: [{ code: "MISSING_MANAGED_FILE", file: "plugins/LSPDFR/Gone.dll" }],
    },
    { canRestore: true }
  );
  assert.equal(plan.fixable, true);
  assert.equal(plan.action, "REPAIR_STORED");
});

test("wrapper-folder files can be healed into place", () => {
  const plan = conditionFix.planRow(
    {
      status: "BROKEN",
      source: "FOLDER",
      reasons: ["All 1 tracked files are missing from the Duty folder."],
      issues: [{ code: "MISSING_MANAGED_FILE" }],
    },
    { canHeal: true }
  );
  assert.equal(plan.fixable, true);
  assert.equal(plan.action, "HEAL_LAYOUT");
});

test("parked required dependencies can be re-enabled", () => {
  const plan = conditionFix.planRow(
    {
      status: "BROKEN",
      source: "SMART",
      reasons: ["A required dependency is missing, disabled, or too old."],
      issues: [],
    },
    { parkedDeps: [{ installId: "rnui", name: "RageNativeUI" }] }
  );
  assert.equal(plan.fixable, true);
  assert.equal(plan.action, "ENABLE_DEP");
});

test("canHealFromWrapper finds a misplaced game-tree copy", () => {
  const duty = dutyWith(["! GTAV MAIN DIRECTORY/plugins/LSPDFR/Callouts.dll"]);
  assert.equal(conditionFix.canHealFromWrapper(duty, ["plugins/LSPDFR/Callouts.dll"]), true);
  assert.equal(conditionFix.canHealFromWrapper(duty, ["plugins/LSPDFR/Missing.dll"]), false);
  cleanup(duty);
});

test("canRestoreFromStore sees a saved payload", () => {
  const dataDir = tmpDir("fix-data-");
  const src = tmpDir("fix-src-");
  writeFile(src, "plugins/LSPDFR/Gone.dll", "DLL");
  saveInstalledFile(dataDir, "mod-1", "plugins/LSPDFR/Gone.dll", path.join(src, "plugins", "LSPDFR", "Gone.dll"));
  assert.equal(
    conditionFix.canRestoreFromStore(
      { id: "mod-1", files: [{ destination: "plugins/LSPDFR/Gone.dll" }] },
      dataDir,
      { issues: [{ code: "MISSING_MANAGED_FILE", file: "plugins/LSPDFR/Gone.dll" }] }
    ),
    true
  );
  cleanup(dataDir, src);
});

test("applyPlans refuses the official Online folder", async () => {
  const folder = tmpDir("same-");
  await assert.rejects(
    () => conditionFix.applyPlans([{ fixable: true, action: "HEAL_LAYOUT" }], { dutyPath: folder, officialPath: folder }),
    /official Online folder/
  );
  cleanup(folder);
});

test("applyPlans heals a wrapper and restores a stored file", async () => {
  const duty = dutyWith(["! GTAV MAIN DIRECTORY/plugins/LSPDFR/Callouts.dll"]);
  const official = tmpDir("official-");
  const dataDir = tmpDir("fix-data-");
  const src = tmpDir("fix-src-");
  writeFile(src, "plugins/LSPDFR/Gone.dll", "RESTORED");
  saveInstalledFile(dataDir, "gone", "plugins/LSPDFR/Gone.dll", path.join(src, "plugins", "LSPDFR", "Gone.dll"));
  const manifest = {
    schemaVersion: 1,
    id: "gone",
    name: "Gone",
    enabled: true,
    files: [{ destination: "plugins/LSPDFR/Gone.dll", hash: "", backup: null }],
  };
  const report = await conditionFix.applyPlans(
    [
      { fixable: true, action: "HEAL_LAYOUT", installId: "callouts", name: "Callouts" },
      { fixable: true, action: "REPAIR_STORED", installId: "gone", name: "Gone" },
    ],
    {
      dutyPath: duty,
      dataDir,
      officialPath: official,
      healDutyLayout: dutyLayoutFix.healDutyLayout,
      repair: ({ modId }) => repairManagedMod({ manifest: { ...manifest, id: modId }, dutyPath: duty, dataDir }),
    }
  );
  assert.equal(fileExists(duty, "plugins/LSPDFR/Callouts.dll"), true);
  assert.equal(fileExists(duty, "plugins/LSPDFR/Gone.dll"), true);
  assert.equal(report.fixed, 2);
  cleanup(duty, official, dataDir, src);
});

test("applyPlans re-enables a parked required dependency", async () => {
  const enabled = [];
  const duty = tmpDir("duty-");
  const official = tmpDir("official-");
  const report = await conditionFix.applyPlans(
    [
      {
        fixable: true,
        action: "ENABLE_DEP",
        installId: "pr",
        name: "Policing Redefined",
        parkedDeps: [{ installId: "rnui", name: "RageNativeUI" }],
      },
    ],
    {
      dutyPath: duty,
      officialPath: official,
      setEnabled: async ({ modId, enabled: on }) => {
        enabled.push({ modId, on });
      },
    }
  );
  assert.deepEqual(enabled, [{ modId: "rnui", on: true }]);
  assert.equal(report.fixed, 1);
  cleanup(duty, official);
});
