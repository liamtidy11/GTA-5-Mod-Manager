const { test } = require("node:test");
const assert = require("node:assert");
const { tmpDir, writeFile, makeFakeDuty, cleanup } = require("./helpers");
const dependencyChecker = require("../src/services/dependencyChecker");

test("flags a missing framework a plugin references", () => {
  const payload = tmpDir("dep-");
  // A .NET assembly embeds the names of assemblies it references.
  writeFile(payload, "MyCallout.dll", "MZ....references RAGENativeUI, Version=1.0....");
  const duty = makeFakeDuty();
  try {
    const files = [
      { source: "MyCallout.dll", destination: "plugins/LSPDFR/MyCallout.dll", action: "add", category: "LSPDFR_PLUGIN" },
    ];
    const result = dependencyChecker.check({ files, payloadRoot: payload, dutyPath: duty });
    const dep = result.dependencies.find((d) => d.name === "RAGENativeUI");
    assert.ok(dep, "RAGENativeUI should be detected");
    assert.equal(dep.present, false);
    assert.equal(result.missingRequired, true);
  } finally {
    cleanup(payload, duty);
  }
});

test("does not flag a framework that the pack bundles", () => {
  const payload = tmpDir("dep-");
  writeFile(payload, "MyCallout.dll", "references RAGENativeUI here");
  writeFile(payload, "RAGENativeUI.dll", "the framework itself");
  const duty = makeFakeDuty();
  try {
    const files = [
      { source: "MyCallout.dll", destination: "plugins/LSPDFR/MyCallout.dll", action: "add" },
      { source: "RAGENativeUI.dll", destination: "plugins/LSPDFR/RAGENativeUI.dll", action: "add" },
    ];
    const result = dependencyChecker.check({ files, payloadRoot: payload, dutyPath: duty });
    const dep = result.dependencies.find((d) => d.name === "RAGENativeUI");
    assert.ok(dep && dep.present, "RAGENativeUI should be marked present");
    assert.equal(result.missingRequired, false);
  } finally {
    cleanup(payload, duty);
  }
});

test("flags Script Hook V .NET dependence as incompatible on Enhanced", () => {
  const payload = tmpDir("dep-");
  writeFile(payload, "SomeScript.dll", "needs ScriptHookVDotNet to run");
  const duty = makeFakeDuty();
  try {
    const files = [{ source: "SomeScript.dll", destination: "scripts/SomeScript.dll", action: "add" }];
    const result = dependencyChecker.check({ files, payloadRoot: payload, dutyPath: duty });
    assert.equal(result.incompatible, true);
    assert.ok(result.compatibility.some((c) => c.level === "incompatible"));
  } finally {
    cleanup(payload, duty);
  }
});

test("warns that mods\\ files need OpenIV", () => {
  const payload = tmpDir("dep-");
  writeFile(payload, "thing.rpf", "data");
  const duty = makeFakeDuty();
  try {
    const files = [{ source: "thing.rpf", destination: "mods/update/x64/thing.rpf", action: "add" }];
    const result = dependencyChecker.check({ files, payloadRoot: payload, dutyPath: duty });
    assert.ok(result.compatibility.some((c) => /OpenIV/i.test(c.name)));
  } finally {
    cleanup(payload, duty);
  }
});
