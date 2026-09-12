const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { tmpDir, cleanup } = require("./helpers");
const runtimeCompatibility = require("../src/services/knowledge/runtimeCompatibility");
const evidenceStore = require("../src/services/knowledge/runtimeEvidence");
const modHealthV2 = require("../src/services/modHealthV2");

function session(overrides = {}) {
  return {
    sessionId: overrides.sessionId || "sess-1",
    result: "CLEAN_EXIT",
    state: "COMPLETED",
    startedAt: "2026-09-13T00:00:00.000Z",
    durationMs: 180000,
    dutyPath: "",
    mods: [{ installId: "future-callouts", enabled: true }],
    ...overrides,
  };
}

function pluginMod(overrides = {}) {
  return {
    id: "future-callouts",
    name: "Future Callouts",
    enabled: true,
    compatibilityStatus: "UNKNOWN",
    files: [{ destination: "plugins/LSPDFR/FutureCallouts.dll" }],
    ...overrides,
  };
}

test("future plugin DLL is identified without a catalog entry", () => {
  const ident = runtimeCompatibility.identities(pluginMod());
  assert.equal(ident.skip, false);
  assert.equal(ident.silent, false);
  assert.equal(ident.observables[0].file, "FutureCallouts.dll");
});

test("wrapper-folder dests still identify a future plugin", () => {
  const ident = runtimeCompatibility.identities(
    pluginMod({
      files: [{ destination: "! GTAV MAIN DIRECTORY/plugins/LSPDFR/NightShift.dll" }],
    })
  );
  assert.equal(ident.observables[0].file, "NightShift.dll");
});

test("bundled UI libraries are not enough to prove a plugin pack loaded", () => {
  const pr = {
    id: "pr-1",
    name: "Policing Redefined",
    enabled: true,
    files: [
      { destination: "plugins/LSPDFR/PolicingRedefined.dll" },
      { destination: "plugins/LSPDFR/RAGENativeUI.dll" },
    ],
  };
  const log = "RAGENativeUI.dll: RAGENativeUI, Version=1.9.0.0\n";
  const verdict = runtimeCompatibility.assessLog(pr, log);
  assert.equal(verdict.status, null);
  assert.equal(verdict.kind, "PLUGIN_UNSEEN");
});

test("a future plugin goes WORKED only when its own plugin actually loaded", () => {
  const dataDir = tmpDir("runtime-");
  const mods = [pluginMod(), pluginMod({ id: "other-callouts", name: "Other Callouts", files: [{ destination: "plugins/LSPDFR/OtherCallouts.dll" }] })];
  const log = [
    "Rage Plugin Hook started",
    "Loading plugin from path: Plugins\\LSPD First Response.dll",
    "Creating plugin: FutureCallouts.Main",
    "Unloading plugins",
    "Normal shutdown",
  ].join("\n");
  const result = runtimeCompatibility.recordFromSession({
    dataDir,
    session: session({ mods: [{ installId: "future-callouts", enabled: true }, { installId: "other-callouts", enabled: true }] }),
    mods,
    logText: log,
  });
  assert.equal(result.recorded.length, 1);
  assert.equal(result.recorded[0].installId, "future-callouts");
  assert.equal(result.recorded[0].status, "WORKED");
  assert.equal(result.recorded[0].source, "LOCAL_VERIFIED_DATA");
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "other-callouts" }), null);
  cleanup(dataDir);
});

test("future plugin terminate is FAILED even on a clean-looking exit", () => {
  const dataDir = tmpDir("runtime-");
  runtimeCompatibility.recordFromSession({
    dataDir,
    session: session(),
    mods: [pluginMod()],
    logText: "Creating plugin: FutureCallouts.Main\nTERMINATING FC: Please fix your configuration files and try again.\nNormal shutdown\n",
  });
  const row = evidenceStore.getEvidence(dataDir, { id: "future-callouts" });
  assert.equal(row.status, "FAILED");
  assert.match(row.evidence, /terminated/i);
  cleanup(dataDir);
});

test("known plugins, ASI, silent packs, and a later unknown pack all get their own check", () => {
  const dataDir = tmpDir("runtime-");
  const mods = [
    {
      id: "pr-1",
      canonicalModId: "policing-redefined",
      name: "Policing Redefined",
      enabled: true,
      files: [{ destination: "plugins/LSPDFR/PolicingRedefined.dll" }],
    },
    {
      id: "stp-1",
      name: "Stop The Ped",
      enabled: true,
      files: [{ destination: "plugins/LSPDFR/StopThePed.dll" }],
    },
    {
      id: "heap-1",
      name: "HeapAdjuster Enhanced",
      enabled: true,
      files: [{ destination: "HeapAdjuster.asi" }],
    },
    {
      id: "cars-1",
      name: "Future Car Pack",
      enabled: true,
      files: [{ destination: "mods/update/x64/dlcpacks/futurecars/dlc.rpf" }],
    },
    {
      id: "rnui-1",
      canonicalModId: "ragenativeui",
      name: "RAGENativeUI",
      enabled: true,
      files: [{ destination: "plugins/LSPDFR/RAGENativeUI.dll" }],
    },
  ];
  const log = [
    "Rage Plugin Hook started",
    "Loading plugin from path: Plugins\\LSPD First Response.dll",
    "Creating plugin: PolicingRedefined.EntryPoint",
    "Creating plugin: StopThePed.Main",
    "RAGENativeUI.dll: RAGENativeUI, Version=1.9.2.0",
    "Loading ASI: HeapAdjuster.asi",
    "Unloading plugins",
    "Normal shutdown",
  ].join("\n");
  runtimeCompatibility.recordFromSession({
    dataDir,
    session: session({
      sessionId: "sess-all",
      mods: mods.map((mod) => ({ installId: mod.id, enabled: true })),
    }),
    mods,
    logText: log,
  });
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "pr-1" }).status, "WORKED");
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "stp-1" }).status, "WORKED");
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "heap-1" }).status, "WORKED");
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "cars-1" }).status, "WORKED");
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "cars-1" }).kind, "SESSION_PRESENT");
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "rnui-1" }).status, "WORKED");
  cleanup(dataDir);
});

test("ScriptHookV is never marked as worked", () => {
  const dataDir = tmpDir("runtime-");
  runtimeCompatibility.recordFromSession({
    dataDir,
    session: session({ mods: [{ installId: "shv-1", enabled: true }] }),
    mods: [
      {
        id: "shv-1",
        name: "Script Hook V",
        canonicalModId: "scripthookv",
        enabled: true,
        files: [{ destination: "ScriptHookV.dll" }],
      },
    ],
    logText: "Rage Plugin Hook started\nLoading ASI: ScriptHookV.asi\nNormal shutdown\n",
  });
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "shv-1" }), null);
  cleanup(dataDir);
});

test("a crash session does not turn an unseen plugin green", () => {
  const dataDir = tmpDir("runtime-");
  runtimeCompatibility.recordFromSession({
    dataDir,
    session: session({ result: "GAME_CRASH", state: "CRASHED" }),
    mods: [pluginMod()],
    logText: "Rage Plugin Hook started\nThe game has crashed\n",
  });
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "future-callouts" }), null);
  cleanup(dataDir);
});

test("later failed evidence overwrites an earlier worked result", () => {
  const dataDir = tmpDir("runtime-");
  const mods = [pluginMod()];
  runtimeCompatibility.recordFromSession({
    dataDir,
    session: session({ sessionId: "good" }),
    mods,
    logText: "Creating plugin: FutureCallouts.Main\nNormal shutdown\n",
  });
  runtimeCompatibility.recordFromSession({
    dataDir,
    session: session({ sessionId: "bad", result: "LSPDFR_CRASH", state: "CRASHED" }),
    mods,
    logText: "Creating plugin: FutureCallouts.Main\nFailed to load plugin: FutureCallouts.dll\n",
  });
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "future-callouts" }).status, "FAILED");
  cleanup(dataDir);
});

test("canonical id still finds evidence after a reinstall id change", () => {
  const dataDir = tmpDir("runtime-");
  runtimeCompatibility.recordFromSession({
    dataDir,
    session: session({ mods: [{ installId: "old-id", enabled: true }] }),
    mods: [pluginMod({ id: "old-id", canonicalModId: "future-callouts" })],
    logText: "Creating plugin: FutureCallouts.Main\nNormal shutdown\n",
  });
  const row = evidenceStore.lookup(evidenceStore.load(dataDir), { id: "new-id", canonicalModId: "future-callouts" });
  assert.equal(row.status, "WORKED");
  cleanup(dataDir);
});

test("unknown catalog compatibility turns green after a local worked session", () => {
  const healthy = modHealthV2.evaluateModHealth(pluginMod(), {
    runtime: { status: "WORKED", kind: "PLUGIN_LOG", evidence: "Creating plugin: FutureCallouts.Main", source: "LOCAL_VERIFIED_DATA" },
  });
  assert.equal(healthy.status, "HEALTHY");
  assert.ok(!healthy.reasons.some((row) => /compatibility.*unknown/i.test(row)));
  assert.ok(healthy.reasons.some((row) => /FutureCallouts/i.test(row)));

  const warn = modHealthV2.evaluateModHealth(pluginMod(), {});
  assert.equal(warn.status, "WARNING");
  assert.ok(warn.reasons.some((row) => /compatibility.*unknown/i.test(row)));

  const failed = modHealthV2.evaluateModHealth(pluginMod(), {
    runtime: { status: "FAILED", evidence: "The session terminated FC." },
  });
  assert.equal(failed.status, "WARNING");
  assert.ok(failed.reasons.some((row) => /terminated FC/i.test(row)));
});

test("trusted incompatible is not overridden by a local worked session", () => {
  const row = modHealthV2.evaluateModHealth(
    { ...pluginMod(), compatibilityStatus: "INCOMPATIBLE" },
    { runtime: { status: "WORKED", evidence: "Creating plugin: FutureCallouts.Main" } }
  );
  assert.equal(row.status, "BROKEN");
});

test("adopt walks older sessions so a later install still gets checked", () => {
  const dataDir = tmpDir("runtime-");
  const duty = tmpDir("runtime-duty-");
  fs.writeFileSync(
    path.join(duty, "RagePluginHook.log"),
    "Creating plugin: BrandNewCallouts.EntryPoint\nUnloading plugins\nNormal shutdown\n",
    "utf8"
  );
  const mods = [
    pluginMod({
      id: "brand-new",
      name: "Brand New Callouts",
      files: [{ destination: "plugins/LSPDFR/BrandNewCallouts.dll" }],
    }),
  ];
  runtimeCompatibility.adoptFromSessions({
    dataDir,
    dutyPath: duty,
    mods,
    sessions: [
      session({
        sessionId: "older",
        startedAt: "2026-09-12T00:00:00.000Z",
        dutyPath: duty,
        mods: [{ installId: "brand-new", enabled: true }],
      }),
    ],
  });
  assert.equal(evidenceStore.getEvidence(dataDir, { id: "brand-new" }).status, "WORKED");
  cleanup(dataDir, duty);
});
