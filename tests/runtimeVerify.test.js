const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, cleanup } = require("./helpers");
const runtimeVerify = require("../src/services/knowledge/runtimeVerify");
const runtimeRuleStore = require("../src/services/knowledge/runtimeRuleStore");
const runtimeCompatibility = require("../src/services/knowledge/runtimeCompatibility");
const evidenceStore = require("../src/services/knowledge/runtimeEvidence");
const modHealthV2 = require("../src/services/modHealthV2");
const dllOwnership = require("../src/services/knowledge/dllOwnership");

function futurePlugin(overrides = {}) {
  return {
    id: "future-plugin",
    name: "Future Plugin",
    enabled: true,
    version: "1.0.0",
    files: [{ destination: "plugins/LSPDFR/FuturePlugin.dll" }],
    ...overrides,
  };
}

test("a future managed DLL can go WORKING without a catalog entry", () => {
  const verdict = runtimeVerify.evaluate(futurePlugin(), {
    logText: "Loaded plugin FuturePlugin.dll\n",
  });
  assert.equal(verdict.status, "WORKING");
  assert.equal(verdict.tier, "GENERIC_PLUGIN");
  assert.match(verdict.evidence, /FuturePlugin\.dll/);
});

test("DLL ownership maps a managed dest to installId, not the display name", () => {
  const map = dllOwnership.ownershipMap([
    futurePlugin({ id: "install-99", name: "Something Else Entirely", canonicalModId: null }),
  ]);
  const owners = dllOwnership.ownersOf(map, "FuturePlugin.dll");
  assert.equal(owners.length, 1);
  assert.equal(owners[0].installId, "install-99");
});

test("Damage Tracker Framework is a built-in service rule, not a hardcoded JS special case", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/services/knowledge/runtimeVerify.js"), "utf8");
  assert.doesNotMatch(src, /DamageTracker/);
  const dtf = {
    id: "dtf-1",
    name: "DamageTrackerFramework 2.0.2",
    canonicalModId: "damage-tracker-framework",
    files: [
      { destination: "DamageTrackerLib.dll" },
      { destination: "plugins/DamageTrackingFramework.dll" },
    ],
  };
  const verdict = runtimeVerify.evaluate(dtf, { logText: "DamageTrackerService Started\n" });
  assert.equal(verdict.status, "WORKING");
  assert.equal(verdict.tier, "BUILT_IN");
});

test("a future service mod works from a generic Service Started line", () => {
  const mod = {
    id: "svc-1",
    name: "Weather Watcher",
    files: [{ destination: "plugins/WeatherWatcher.dll" }],
  };
  const verdict = runtimeVerify.evaluate(mod, { logText: "WeatherWatcherService Started\n" });
  assert.equal(verdict.status, "WORKING");
  assert.equal(verdict.kind, "SERVICE_STARTED");
});

test("PRIMARY needs one runtime DLL; ALL needs every required component", () => {
  const mod = {
    id: "multi-1",
    name: "Twin Pack",
    files: [
      { destination: "plugins/LSPDFR/MainPlugin.dll" },
      { destination: "plugins/LSPDFR/SupportPlugin.dll" },
    ],
  };
  const one = "Loaded plugin MainPlugin.dll\n";
  const both = `${one}Loaded plugin SupportPlugin.dll\n`;
  assert.equal(runtimeVerify.evaluate({ ...mod, runtimeMatchMode: "PRIMARY" }, { logText: one }).status, "WORKING");
  assert.equal(runtimeVerify.evaluate({ ...mod, runtimeMatchMode: "ALL" }, { logText: one }).status, "UNVERIFIED");
  assert.equal(runtimeVerify.evaluate({ ...mod, runtimeMatchMode: "ALL" }, { logText: both }).status, "WORKING");
});

test("user override contains-match marks WORKING and never uses scripts", () => {
  const dataDir = tmpDir("rule-");
  const mod = futurePlugin();
  runtimeRuleStore.setUserRule(dataDir, {
    installId: mod.id,
    contains: "FuturePlugin initialized successfully",
  });
  const verdict = runtimeVerify.evaluate(mod, {
    dataDir,
    logText: "[12:00] FuturePlugin initialized successfully\n",
  });
  assert.equal(verdict.status, "WORKING");
  assert.equal(verdict.tier, "USER_OVERRIDE");
  const stored = runtimeRuleStore.loadUser(dataDir);
  assert.equal(stored.rules[mod.id].positiveSignals[0].contains, "FuturePlugin initialized successfully");
  cleanup(dataDir);
});

test("suggestSignals never writes a local rule", () => {
  const dataDir = tmpDir("suggest-");
  const before = runtimeRuleStore.loadUser(dataDir);
  const suggestions = runtimeVerify.suggestSignals(
    futurePlugin(),
    "FuturePlugin initialized successfully\nCreating plugin: FuturePlugin.Main\n"
  );
  assert.ok(suggestions.some((line) => /initialized successfully/i.test(line)));
  assert.deepEqual(runtimeRuleStore.loadUser(dataDir).rules, before.rules);
  cleanup(dataDir);
});

test("a version change drops prior WORKED evidence until the new version is seen", () => {
  const dataDir = tmpDir("ver-");
  const v1 = futurePlugin({ version: "1.8.0", sourceArchiveHash: "hash-18" });
  runtimeCompatibility.recordFromSession({
    dataDir,
    session: {
      sessionId: "s-18",
      result: "CLEAN_EXIT",
      mods: [{ installId: v1.id, enabled: true, version: "1.8.0", hash: "hash-18" }],
    },
    mods: [v1],
    logText: "Creating plugin: FuturePlugin.Main\n",
  });
  const worked = evidenceStore.getEvidence(dataDir, v1);
  assert.equal(worked.status, "WORKED");
  assert.equal(evidenceStore.versionHistory(evidenceStore.load(dataDir), v1.id)[0].worked, 1);

  const v2 = futurePlugin({ version: "1.9.0", sourceArchiveHash: "hash-19" });
  assert.equal(evidenceStore.lookup(evidenceStore.load(dataDir), v2), null);

  const duty = tmpDir("ver-duty-");
  fs.writeFileSync(path.join(duty, "RagePluginHook.log"), "Creating plugin: FuturePlugin.Main\n", "utf8");
  const live = runtimeCompatibility.lookupLive(evidenceStore.load(dataDir), v2, duty);
  assert.equal(live, null);

  const waiting = modHealthV2.evaluateModHealth(v2, { runtime: live });
  assert.equal(waiting.status, "WARNING");
  assert.ok(waiting.reasons.some((row) => /waiting for runtime/i.test(row)));
  cleanup(dataDir, duty);
});

test("trusted consumer evidence can mark a framework WORKING at MEDIUM only", () => {
  const catalog = {
    mods: [{ id: "policing-redefined", dependencies: [{ modId: "ragenativeui", kind: "REQUIRED" }] }],
  };
  const pr = {
    id: "pr-1",
    name: "Policing Redefined",
    canonicalModId: "policing-redefined",
    enabled: true,
    files: [{ destination: "plugins/LSPDFR/PolicingRedefined.dll" }],
  };
  const rnui = {
    id: "rnui-1",
    name: "RAGENativeUI",
    canonicalModId: "ragenativeui",
    enabled: true,
    files: [{ destination: "plugins/LSPDFR/RAGENativeUI.dll" }],
  };
  const verdict = runtimeVerify.evaluate(rnui, {
    catalog,
    mods: [pr, rnui],
    logText: "Creating plugin: PolicingRedefined.EntryPoint\n",
  });
  assert.equal(verdict.status, "WORKING");
  assert.equal(verdict.kind, "INDIRECT");
  assert.equal(verdict.confidence, "MEDIUM");
});

test("bundled RAGENativeUI.dll still does not prove Policing Redefined loaded", () => {
  const pr = {
    id: "pr-1",
    name: "Policing Redefined",
    files: [
      { destination: "plugins/LSPDFR/PolicingRedefined.dll" },
      { destination: "plugins/LSPDFR/RAGENativeUI.dll" },
    ],
  };
  const verdict = runtimeVerify.evaluate(pr, { logText: "RAGENativeUI.dll: RAGENativeUI, Version=1.9.0.0\n" });
  assert.equal(verdict.status, "UNVERIFIED");
});

test("a plugin that loads then reports a missing dependency is FAILED, not healthy", () => {
  const grammar = {
    id: "ragenativeui-4-mtyn8y3g65h",
    name: "GrammarPolice-1.8.3.1 (2)",
    canonicalModId: "ragenativeui",
    files: [
      { destination: "plugins/LSPDFR/CalloutInterfaceAPI.dll" },
      { destination: "RAGENativeUI.dll" },
      { destination: "plugins/LSPDFR/GrammarPolice.dll" },
    ],
  };
  const log = [
    "GrammarPolice.dll: GrammarPolice, Version=1.8.3.1, Culture=neutral, PublicKeyToken=null",
    "RAGENativeUI.dll: RAGENativeUI, Version=1.9.3.0, Culture=neutral, PublicKeyToken=null",
    "Creating plugin: GrammarPolice.Main",
    "GrammarPolice dependency CalloutInterfaceAPI.dll is not available.",
  ].join("\n");
  const verdict = runtimeVerify.evaluate(grammar, { logText: log });
  assert.equal(verdict.status, "FAILED");
  assert.match(verdict.evidence, /CalloutInterfaceAPI\.dll is not available/i);
  const health = modHealthV2.evaluateModHealth(grammar, {
    runtime: { status: "FAILED", evidence: verdict.evidence },
  });
  assert.equal(health.status, "BROKEN");
});

test("Callout Interface owns its own missing-API line", () => {
  const ci = {
    id: "ci-1",
    name: "CalloutInterface-1.4.1",
    files: [
      { destination: "plugins/LSPDFR/CalloutInterface.dll" },
      { destination: "plugins/LSPDFR/CalloutInterfaceAPI.dll" },
    ],
  };
  const verdict = runtimeVerify.evaluate(ci, {
    logText: "[9/13/2026 2:12:52 PM.065] LSPD First Response: CalloutInterface dependency CalloutInterfaceAPI.dll is not available.\n",
  });
  assert.equal(verdict.status, "FAILED");
  assert.match(verdict.evidence, /CalloutInterfaceAPI\.dll is not available/i);
});

test("LSPDFR core is not failed by another plugin's missing-dependency line", () => {
  const lspdfr = {
    id: "lspdfr-setup",
    name: "lspdfr_049_9695_setup.exe",
    files: [{ destination: "plugins/LSPD First Response.dll" }],
  };
  const verdict = runtimeVerify.evaluate(lspdfr, {
    logText: "[9/13/2026 2:12:52 PM.065] LSPD First Response: CalloutInterface dependency CalloutInterfaceAPI.dll is not available.\n",
  });
  assert.notEqual(verdict.status, "FAILED");
});

test("a missing-dependency line does not fail an unrelated plugin", () => {
  const other = {
    id: "ci-1",
    name: "Callout Interface",
    files: [{ destination: "plugins/LSPDFR/CalloutInterface.dll" }],
  };
  const verdict = runtimeVerify.evaluate(other, {
    logText: "Creating plugin: GrammarPolice.Main\nGrammarPolice dependency CalloutInterfaceAPI.dll is not available.\n",
  });
  assert.notEqual(verdict.status, "FAILED");
});

test("explicit plugin failure is FAILED and turns the lamp red", () => {
  const verdict = runtimeVerify.evaluate(futurePlugin(), {
    logText: "Failed to load plugin: FuturePlugin.dll\n",
  });
  assert.equal(verdict.status, "FAILED");
  const health = modHealthV2.evaluateModHealth(futurePlugin(), {
    runtime: { status: "FAILED", evidence: verdict.evidence },
  });
  assert.equal(health.status, "BROKEN");
});

test("runtime recording writes only manager userData, never an official folder", () => {
  const dataDir = tmpDir("ev-");
  const official = tmpDir("official-");
  const sentinel = path.join(official, "GTA5_Enhanced.exe");
  fs.writeFileSync(sentinel, "official-bytes");
  runtimeCompatibility.recordFromSession({
    dataDir,
    dutyPath: official,
    session: { sessionId: "s1", result: "CLEAN_EXIT", mods: [{ installId: "future-plugin", enabled: true }] },
    mods: [futurePlugin()],
    logText: "Creating plugin: FuturePlugin.Main\n",
  });
  assert.equal(fs.readFileSync(sentinel, "utf8"), "official-bytes");
  assert.equal(fs.readdirSync(official).join(","), "GTA5_Enhanced.exe");
  cleanup(dataDir, official);
});
