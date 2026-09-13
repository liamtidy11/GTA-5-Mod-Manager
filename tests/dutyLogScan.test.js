const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeFile, cleanup } = require("./helpers");
const dutyLogScan = require("../src/services/knowledge/dutyLogScan");
const runtimeVerify = require("../src/services/knowledge/runtimeVerify");
const runtimeCompatibility = require("../src/services/knowledge/runtimeCompatibility");

function fakeDuty() {
  const duty = tmpDir("scan-duty-");
  fs.writeFileSync(path.join(duty, "GTA5_Enhanced.exe"), "exe");
  return duty;
}

test("discovers root ASI logs, plugin logs, and rotated RPH logs under Duty only", () => {
  const duty = fakeDuty();
  const official = tmpDir("scan-online-");
  fs.writeFileSync(path.join(official, "RagePluginHook.log"), "ONLINE MUST NOT BE READ\n");
  writeFile(duty, "RagePluginHook.log", "Creating plugin: FuturePlugin.Main\n");
  writeFile(duty, "HeapAdjuster.log", "Heap Size Adjusted to: 1024\n");
  writeFile(duty, "Logs/RagePluginHook_13092026_134400.log", "old rotated\n");
  writeFile(duty, "plugins/LSPDFR/FuturePlugin/FuturePlugin.log", "FuturePlugin initialized successfully\n");
  writeFile(duty, "BattlEye/EULA/en.txt", "license\n");
  writeFile(duty, "update/x64/data/errorcodes/american.txt", "error\n");
  dutyLogScan.clearCache();
  const files = dutyLogScan.discoverDutyLogs(duty);
  const names = files.map((abs) => path.basename(abs)).sort();
  assert.ok(names.includes("RagePluginHook.log"));
  assert.ok(names.includes("HeapAdjuster.log"));
  assert.ok(names.includes("FuturePlugin.log"));
  assert.ok(names.includes("RagePluginHook_13092026_134400.log"));
  assert.ok(!names.includes("en.txt"));
  assert.ok(!names.includes("american.txt"));
  assert.ok(files.every((abs) => dutyLogScan.insideDuty(duty, abs)));
  assert.ok(!files.some((abs) => abs.toLowerCase().includes(official.toLowerCase())));
  cleanup(duty, official);
});

test("does not follow a path outside the Duty folder", () => {
  const duty = fakeDuty();
  const outside = tmpDir("scan-out-");
  fs.writeFileSync(path.join(outside, "secret.log"), "secret\n");
  dutyLogScan.clearCache();
  const files = dutyLogScan.discoverDutyLogs(duty);
  assert.ok(!files.some((abs) => abs.toLowerCase().includes("secret.log")));
  cleanup(duty, outside);
});

test("an ASI own log can mark that ASI WORKING without a catalog entry", () => {
  const verdict = runtimeVerify.evaluate(
    {
      id: "heap-1",
      name: "HeapAdjuster Enhanced",
      files: [{ destination: "HeapAdjuster.asi" }],
    },
    {
      logText: "",
      logFiles: [{ name: "HeapAdjuster.log", text: "Vanilla Heap Size is: 646\nHeap Size Adjusted to: 1024\n" }],
    }
  );
  assert.equal(verdict.status, "WORKING");
  assert.equal(verdict.kind, "OWN_LOG");
});

test("lookupLive reads a plugin folder log that RPH itself never mentioned", () => {
  const duty = fakeDuty();
  writeFile(duty, "plugins/LSPDFR/NightShift.dll", "dll");
  writeFile(duty, "plugins/LSPDFR/NightShift/NightShift.log", "NightShift initialized successfully\n");
  dutyLogScan.clearCache();
  const live = runtimeCompatibility.lookupLive(
    { mods: {} },
    { id: "ns-1", name: "Night Shift", files: [{ destination: "plugins/LSPDFR/NightShift.dll" }] },
    duty
  );
  assert.equal(live.status, "WORKED");
  assert.match(live.evidence, /initialized successfully/i);
  cleanup(duty);
});
