const { test } = require("node:test");
const assert = require("node:assert/strict");
const { writeFile, makeFakeDuty, cleanup } = require("./helpers");
const discoveredMods = require("../src/services/discoveredMods");
const { installedState } = require("../src/services/workshop/installedMatch");
const environmentInventory = require("../src/services/environmentInventory");
const { loadCatalog } = require("../src/services/workshop/catalog");
const modKnowledge = require("../src/services/modKnowledge");

test("Duty plugins without a Smart Install record appear as Callout Interface and Grammar Police", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPDFR/CalloutInterface.dll", "CI");
  writeFile(duty, "plugins/LSPDFR/CalloutInterfaceAPI.dll", "API");
  writeFile(duty, "plugins/LSPDFR/GrammarPolice.dll", "GP");
  writeFile(duty, "plugins/LSPDFR/RAGENativeUI.dll", "UI");
  writeFile(duty, "plugins/LSPDFR/PolicingRedefined.dll", "PR");
  const inventory = environmentInventory.getInventory({ dutyPath: duty, refresh: true });
  const listed = discoveredMods.list({
    dutyPath: duty,
    inventory,
    smartMods: [
      {
        id: "pr-1",
        name: "Policing Redefined",
        files: [{ destination: "plugins/LSPDFR/PolicingRedefined.dll" }],
      },
    ],
    database: modKnowledge.load(),
    catalog: loadCatalog().catalog,
  });
  const names = listed.map((mod) => mod.name).sort();
  assert.deepEqual(names, ["Callout Interface", "Grammar Police"]);
  assert.ok(listed.every((mod) => mod.discovery === "DISK"));
  assert.equal(
    listed.some((mod) => /CalloutInterfaceAPI|RAGENativeUI|Policing/i.test(mod.name)),
    false
  );
  cleanup(duty);
});

test("Downloads, ASI, and the game itself are not listed as mods", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "HeapAdjuster.asi", "heap");
  writeFile(duty, "ScriptHookV.dll", "shv");
  writeFile(duty, "plugins/LSPD First Response.dll", "lspdfr");
  writeFile(duty, "RagePluginHook.exe", "rph");
  writeFile(duty, "plugins/LSPDFR/GrammarPolice.dll", "GP");
  const inventory = environmentInventory.getInventory({ dutyPath: duty, refresh: true });
  const listed = discoveredMods.list({
    dutyPath: duty,
    inventory,
    smartMods: [],
    database: modKnowledge.load(),
    catalog: loadCatalog().catalog,
  });
  const names = listed.map((mod) => mod.name);
  assert.deepEqual(names, ["Grammar Police"]);
  assert.equal(names.some((name) => /HeapAdjuster|Script Hook|LSPDFR|RAGE Plugin/i.test(name)), false);
  cleanup(duty);
});

test("catalog marks Callout Interface installed from the Duty plugin DLL", () => {
  const state = installedState(
    { canonicalModId: "callout-interface", id: "callout-interface", dllNames: ["CalloutInterface.dll"], aliases: ["CalloutInterface"] },
    {
      mods: [],
      inventory: { plugins: [{ name: "CalloutInterface.dll", file: "plugins/LSPDFR/CalloutInterface.dll", version: "UNKNOWN" }] },
    }
  );
  assert.equal(state.installed, true);
  assert.equal(state.match, "inventory");
});
