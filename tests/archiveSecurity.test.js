const { test } = require("node:test");
const assert = require("node:assert");
const sec = require("../src/services/archiveSecurity");

test("directory traversal paths are detected", () => {
  assert.equal(sec.isTraversal("../../Windows/System32/evil.dll"), true);
  assert.equal(sec.isTraversal("a/../../b"), true);
  assert.equal(sec.isTraversal("/etc/passwd"), true);
  assert.equal(sec.isTraversal("C:\\Windows\\x.dll"), true);
});

test("normal relative paths are allowed", () => {
  assert.equal(sec.isTraversal("plugins/LSPDFR/MyCallout.dll"), false);
  assert.equal(sec.isTraversal("Test.asi"), false);
});

test("validateEntries rejects traversal and surfaces executables", () => {
  const result = sec.validateEntries([
    "plugins/LSPDFR/MyCallout.dll",
    "install.bat",
    "setup.exe",
    "../escape.dll",
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.traversal, ["../escape.dll"]);
  assert.deepEqual(result.executables.sort(), ["install.bat", "setup.exe"]);
});

test("validateEntries passes a clean pack and lists no executables", () => {
  const result = sec.validateEntries(["plugins/LSPDFR/MyCallout.dll", "Test.asi"]);
  assert.equal(result.ok, true);
  assert.equal(result.executables.length, 0);
});
