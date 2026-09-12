const { test } = require("node:test");
const assert = require("node:assert");
const { tmpDir, writeFile, cleanup } = require("./helpers");
const modScanner = require("../src/services/modScanner");
const modClassifier = require("../src/services/modClassifier");

test("structured LSPDFR plugin keeps its plugins/LSPDFR destination", () => {
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/MyCallout.dll", "PLUGIN");
  writeFile(payload, "readme.txt", "install instructions");
  try {
    const scan = modScanner.scan(payload);
    const result = modClassifier.classify(scan);
    const plugin = result.perFile.find((f) => f.rel.endsWith("MyCallout.dll"));
    assert.ok(plugin, "plugin file should be classified");
    assert.equal(plugin.category, "LSPDFR_PLUGIN");
    assert.equal(plugin.destination, "plugins/LSPDFR/MyCallout.dll");
    // The readme is junk and must not be in the plan.
    assert.equal(result.perFile.some((f) => f.rel.endsWith("readme.txt")), false);
    assert.equal(result.type, "LSPDFR_PLUGIN");
  } finally {
    cleanup(payload);
  }
});

test("a wrapper folder is collapsed but a plugins/ folder is preserved", () => {
  const payload = tmpDir("payload-");
  writeFile(payload, "MyMod v1.2/plugins/LSPDFR/Cool.dll", "PLUGIN");
  try {
    const scan = modScanner.scan(payload);
    const result = modClassifier.classify(scan);
    const plugin = result.perFile.find((f) => f.rel.endsWith("Cool.dll"));
    assert.equal(plugin.destination, "plugins/LSPDFR/Cool.dll");
  } finally {
    cleanup(payload);
  }
});

test("an .asi at the root is classified as an ASI mod at root", () => {
  const payload = tmpDir("payload-");
  writeFile(payload, "Menyoo.asi", "ASI");
  try {
    const scan = modScanner.scan(payload);
    const result = modClassifier.classify(scan);
    const asi = result.perFile.find((f) => f.rel.endsWith("Menyoo.asi"));
    assert.equal(asi.category, "ASI");
    assert.equal(asi.destination, "Menyoo.asi");
  } finally {
    cleanup(payload);
  }
});

test("a loose callout DLL is routed to plugins/LSPDFR by name", () => {
  const payload = tmpDir("payload-");
  writeFile(payload, "TrafficPolicer.dll", "PLUGIN");
  try {
    const scan = modScanner.scan(payload);
    const result = modClassifier.classify(scan);
    const dll = result.perFile.find((f) => f.rel.endsWith("TrafficPolicer.dll"));
    assert.equal(dll.category, "LSPDFR_PLUGIN");
    assert.equal(dll.destination, "plugins/LSPDFR/TrafficPolicer.dll");
  } finally {
    cleanup(payload);
  }
});
