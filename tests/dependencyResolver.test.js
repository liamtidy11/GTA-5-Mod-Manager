const { test } = require("node:test");
const assert = require("node:assert");
const { tmpDir, writeFile, makeFakeDuty, cleanup } = require("./helpers");
const readmeAnalyzer = require("../src/services/readmeAnalyzer");
const dependencyResolver = require("../src/services/dependencyResolver");
const modKnowledge = require("../src/services/modKnowledge");
const smartInstall = require("../src/services/smartInstall");

function db() {
  return modKnowledge.load();
}

function inventory(overrides = {}) {
  return {
    components: [],
    frameworks: [],
    plugins: [],
    parkedBasenames: [],
    ...overrides,
  };
}

function dep(result, id) {
  return result.dependencies.find((item) => item.modId === id);
}

function readmeOf(text) {
  return readmeAnalyzer.analyze({ readmeText: text }, { database: db() });
}

test("README required dependency", () => {
  const result = readmeOf("Requires LemonUI");
  const item = result.dependencies.find((d) => d.modId === "lemonui");
  assert.ok(item);
  assert.equal(item.kind, "REQUIRED");
  assert.equal(item.source, "README");
  assert.equal(item.confidence, "MEDIUM");
  assert.match(item.evidence, /Requires LemonUI/);
});

test("README optional dependency", () => {
  const result = readmeOf("Optional: StopThePed integration");
  const item = result.dependencies.find((d) => d.modId === "stop-the-ped");
  assert.ok(item);
  assert.equal(item.kind, "OPTIONAL");
});

test("README recommended dependency", () => {
  const result = readmeOf("Recommended: Ultimate Backup");
  const item = result.dependencies.find((d) => d.modId === "ultimate-backup");
  assert.ok(item);
  assert.equal(item.kind, "RECOMMENDED");
});

test("README ambiguous wording", () => {
  const result = readmeOf("This pack mentions LemonUI in passing.\nDoes not require RAGENativeUI.");
  assert.equal(
    result.dependencies.some((d) => d.modId === "lemonui"),
    false,
    "a bare mention without a requirement phrase is not evidence"
  );
  const rnui = result.dependencies.find((d) => d.modId === "ragenativeui");
  assert.ok(rnui);
  assert.equal(rnui.kind, "UNKNOWN");
});

test("README version requirement", () => {
  const result = readmeOf(
    "LemonUI 1.9.0 or newer\nRequires LSPDFR >= 0.4.9\nRequires RPH 1.130+"
  );
  const lemon = result.dependencies.find((d) => d.modId === "lemonui");
  const lspdfr = result.dependencies.find((d) => d.modId === "lspdfr");
  const rph = result.dependencies.find((d) => d.modId === "rage-plugin-hook");
  assert.equal(lemon.version, ">= 1.9.0");
  assert.equal(lspdfr.version, ">= 0.4.9");
  assert.equal(rph.version, ">= 1.130");
});

test("README unknown version phrase", () => {
  const result = readmeOf("Requires the latest LemonUI");
  const item = result.dependencies.find((d) => d.modId === "lemonui");
  assert.ok(item);
  assert.equal(item.kind, "REQUIRED");
  assert.equal(item.version, "UNKNOWN");
});

test("README only inspects documentation filenames", () => {
  assert.equal(readmeAnalyzer.isDocFile("README.txt"), true);
  assert.equal(readmeAnalyzer.isDocFile("INSTALLATION.md"), true);
  assert.equal(readmeAnalyzer.isDocFile("REQUIREMENTS.txt"), true);
  assert.equal(readmeAnalyzer.isDocFile("CHANGELOG.txt"), true);
  assert.equal(readmeAnalyzer.isDocFile("plugins/LSPDFR/Callout.dll"), false);
  assert.equal(readmeAnalyzer.isDocFile("docs/deep/nested/secret.txt"), false);
});

test("knowledge DB dependency schema accepts objects and component IDs", () => {
  const parsed = modKnowledge.parseDatabase(
    {
      schemaVersion: 1,
      mods: [
        {
          id: "sample-mod",
          name: "Sample Mod",
          dependencies: [
            { modId: "lemonui", kind: "REQUIRED", version: ">= 1.2.0", notes: "" },
            { componentId: "lspdfr", kind: "REQUIRED" },
          ],
          optionalDependencies: ["stop-the-ped"],
        },
      ],
    },
    "TEST"
  );
  assert.equal(parsed.mods[0].dependencies[0].modId, "lemonui");
  assert.equal(parsed.mods[0].dependencies[0].version, ">= 1.2.0");
  assert.equal(parsed.mods[0].dependencies[1].modId, "lspdfr");
  assert.equal(parsed.mods[0].optionalDependencies[0].kind, "OPTIONAL");
});

test("knowledge DB dependency", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      frameworks: [{ id: "lemonui", name: "LemonUI", installed: true, enabled: true, state: "INSTALLED", version: "1.2.0" }],
    }),
    recognition: {
      modId: "sample-mod",
      knowledge: {
        dependencies: [{ modId: "lemonui", kind: "REQUIRED", version: ">= 1.2.0" }],
      },
    },
  });
  const item = dep(result, "lemonui");
  assert.equal(item.source, "KNOWLEDGE_DATABASE");
  assert.equal(item.kind, "REQUIRED");
  assert.equal(item.state, "INSTALLED");
  assert.equal(item.requiredVersion, ">= 1.2.0");
});

test("manifest dependency", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory(),
    manifestDependencies: [{ modId: "ifruitaddon2", name: "iFruitAddon2", kind: "REQUIRED" }],
  });
  const item = dep(result, "ifruitaddon2");
  assert.equal(item.source, "APP_MANIFEST");
  assert.equal(item.state, "MISSING");
});

test("source priority prefers APP_MANIFEST over README", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory(),
    manifestDependencies: [{ modId: "lemonui", kind: "OPTIONAL" }],
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED", evidence: "Requires LemonUI" }] },
  });
  const item = dep(result, "lemonui");
  assert.equal(item.source, "APP_MANIFEST");
  assert.equal(item.kind, "OPTIONAL");
  assert.deepEqual(item.sources, ["APP_MANIFEST", "README"]);
});

test("duplicate evidence merge", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory(),
    recognition: {
      knowledge: { dependencies: [{ modId: "lemonui", kind: "REQUIRED" }] },
    },
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED", evidence: "Requires LemonUI" }] },
  });
  assert.equal(result.dependencies.filter((d) => d.modId === "lemonui").length, 1);
  const item = dep(result, "lemonui");
  assert.ok(item.sources.includes("KNOWLEDGE_DATABASE"));
  assert.ok(item.sources.includes("README"));
  assert.equal(item.evidenceConflict, false);
});

test("conflicting evidence is preserved", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory(),
    recognition: {
      knowledge: { dependencies: [{ modId: "stop-the-ped", kind: "OPTIONAL" }] },
    },
    readme: {
      dependencies: [{ modId: "stop-the-ped", name: "Stop The Ped", kind: "REQUIRED", evidence: "Requires StopThePed" }],
    },
  });
  const item = dep(result, "stop-the-ped");
  assert.equal(item.kind, "OPTIONAL");
  assert.equal(item.source, "KNOWLEDGE_DATABASE");
  assert.equal(item.evidenceConflict, true);
});

test("installed dependency", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      frameworks: [{ id: "lemonui", name: "LemonUI", installed: true, enabled: true, state: "INSTALLED", version: "1.9.1" }],
    }),
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED" }] },
  });
  const item = dep(result, "lemonui");
  assert.equal(item.state, "INSTALLED");
  assert.equal(item.installedVersion, "1.9.1");
});

test("missing dependency", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory(),
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED" }] },
  });
  assert.equal(dep(result, "lemonui").state, "MISSING");
});

test("disabled dependency", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      plugins: [{ name: "StopThePed.dll", enabled: false, version: "4.9.5" }],
    }),
    readme: { dependencies: [{ modId: "stop-the-ped", name: "Stop The Ped", kind: "OPTIONAL" }] },
  });
  const item = dep(result, "stop-the-ped");
  assert.equal(item.state, "DISABLED");
  assert.notEqual(item.state, "MISSING");
});

test("parked dependency", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      components: [
        { id: "scripthookv", name: "Script Hook V", installed: true, enabled: false, state: "PARKED", version: "1.0" },
        {
          id: "scripthookvdotnet",
          name: "Script Hook V .NET",
          installed: true,
          enabled: false,
          state: "PARKED",
          version: "3.6",
        },
      ],
    }),
    readme: {
      dependencies: [
        { modId: "scripthookv", name: "Script Hook V", kind: "REQUIRED" },
        { modId: "scripthookvdotnet", name: "Script Hook V .NET", kind: "REQUIRED" },
      ],
    },
  });
  assert.equal(dep(result, "scripthookv").state, "DISABLED");
  assert.equal(dep(result, "scripthookvdotnet").state, "DISABLED");
});

test("version satisfied", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      frameworks: [{ id: "lemonui", installed: true, enabled: true, state: "INSTALLED", version: "1.9.1" }],
    }),
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED", version: ">= 1.9.0" }] },
  });
  assert.equal(dep(result, "lemonui").state, "INSTALLED");
});

test("version too old", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      frameworks: [{ id: "lemonui", installed: true, enabled: true, state: "INSTALLED", version: "1.8.0" }],
    }),
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED", version: ">= 1.9.0" }] },
  });
  assert.equal(dep(result, "lemonui").state, "VERSION_TOO_OLD");
});

test("version too new", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      frameworks: [{ id: "lemonui", installed: true, enabled: true, state: "INSTALLED", version: "2.1.0" }],
    }),
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED", version: "<= 2.0.0" }] },
  });
  assert.equal(dep(result, "lemonui").state, "VERSION_TOO_NEW");
});

test("unknown installed version", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      frameworks: [{ id: "lemonui", installed: true, enabled: true, state: "INSTALLED", version: "UNKNOWN" }],
    }),
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED", version: ">= 1.9.0" }] },
  });
  assert.equal(dep(result, "lemonui").state, "UNKNOWN");
});

test("unknown requirement", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      frameworks: [{ id: "lemonui", installed: true, enabled: true, state: "INSTALLED", version: "1.9.1" }],
    }),
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED", version: "UNKNOWN" }] },
  });
  const item = dep(result, "lemonui");
  assert.equal(item.requiredVersion, "UNKNOWN");
  assert.equal(item.state, "INSTALLED");
});

test("bundled dependency", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory(),
    packFiles: [{ source: "LemonUI.dll", destination: "LemonUI.dll" }],
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED" }] },
  });
  const item = dep(result, "lemonui");
  assert.equal(item.state, "BUNDLED");
  assert.equal(item.destination, "LemonUI.dll");
  assert.equal(item.fileConflict, false);
});

test("bundled dependency version", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory(),
    packFiles: [{ source: "LemonUI.dll", destination: "LemonUI.dll", version: "1.9.1" }],
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED" }] },
  });
  assert.equal(dep(result, "lemonui").bundledVersion, "1.9.1");
});

test("bundled dependency conflict metadata", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      frameworks: [{ id: "lemonui", installed: true, enabled: true, state: "INSTALLED", version: "1.8.0" }],
    }),
    packFiles: [{ source: "LemonUI.dll", destination: "LemonUI.dll", version: "1.9.1" }],
    readme: { dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED" }] },
  });
  const item = dep(result, "lemonui");
  assert.equal(item.state, "BUNDLED");
  assert.equal(item.installedVersion, "1.8.0");
  assert.equal(item.bundledVersion, "1.9.1");
  assert.equal(item.fileConflict, true);
});

test("alias resolution", () => {
  assert.equal(dependencyResolver.nameToId("StopThePed", db()), "stop-the-ped");
  assert.equal(dependencyResolver.nameToId("Stop The Ped", db()), "stop-the-ped");
  assert.equal(dependencyResolver.nameToId("stop the ped", db()), "stop-the-ped");
  const result = readmeOf("Requires StopThePed");
  assert.equal(result.dependencies[0].modId, "stop-the-ped");
});

test("dependency summary", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      components: [
        { id: "lspdfr", installed: true, enabled: true, state: "INSTALLED", version: "0.4.9" },
        { id: "rage-plugin-hook", installed: true, enabled: true, state: "INSTALLED", version: "1.131" },
      ],
    }),
    readme: {
      dependencies: [
        { modId: "lspdfr", name: "LSPDFR", kind: "REQUIRED" },
        { modId: "rage-plugin-hook", name: "RAGE Plugin Hook", kind: "REQUIRED" },
        { modId: "lemonui", name: "LemonUI", kind: "REQUIRED" },
        { modId: "stop-the-ped", name: "Stop The Ped", kind: "OPTIONAL" },
      ],
    },
  });
  assert.deepEqual(result.summary, {
    requiredTotal: 3,
    requiredSatisfied: 2,
    requiredMissing: 1,
    requiredDisabled: 0,
    optionalMissing: 1,
    hasBlockingDependencyIssue: true,
  });
});

test("unknown dependency identity", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory(),
    readme: {
      dependencies: [{ name: "Mystery Framework", modId: "", kind: "REQUIRED", evidence: "Requires Mystery Framework" }],
    },
  });
  assert.equal(result.dependencies.length, 1);
  assert.equal(result.dependencies[0].modId, "");
  assert.equal(result.dependencies[0].state, "MISSING");
  assert.equal(result.dependencies[0].name, "Mystery Framework");
});

test("INCOMPATIBLE is only used when metadata says so", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory(),
    manifestDependencies: [{ modId: "scripthookvdotnet", kind: "REQUIRED", incompatible: true }],
  });
  assert.equal(dep(result, "scripthookvdotnet").state, "INCOMPATIBLE");
});

test("parked Script Hook V .NET stays DISABLED, not INCOMPATIBLE", () => {
  const result = dependencyResolver.resolve({
    database: db(),
    inventory: inventory({
      components: [
        { id: "scripthookvdotnet", installed: true, enabled: false, state: "PARKED", version: "3.6" },
      ],
    }),
    manifestDependencies: [{ modId: "scripthookvdotnet", kind: "REQUIRED", incompatible: true }],
  });
  assert.equal(dep(result, "scripthookvdotnet").state, "DISABLED");
});

test("Smart Install analysis attaches dependency results without blocking", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Callout.dll", "CALLOUT");
  writeFile(payload, "README.txt", "Requires LemonUI\nOptional: StopThePed integration");
  try {
    const preview = await smartInstall.analyze({
      source: payload,
      dutyPath: duty,
      dataDir,
      stagingRoot: staging,
    });
    assert.ok(Array.isArray(preview.resolvedDependencies));
    assert.ok(preview.dependencySummary);
    assert.ok(preview.readmeEvidence.some((d) => d.modId === "lemonui" && d.kind === "REQUIRED"));
    const lemon = preview.resolvedDependencies.find((d) => d.modId === "lemonui");
    assert.ok(lemon);
    assert.equal(lemon.state, "MISSING");
    assert.notEqual(preview.conflicts.severity, "BLOCKED");
    const usable = preview.files.filter((f) => f.action === "add" || f.action === "replace");
    assert.ok(usable.some((f) => f.destination.replace(/\\/g, "/").endsWith("Callout.dll")));
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});
