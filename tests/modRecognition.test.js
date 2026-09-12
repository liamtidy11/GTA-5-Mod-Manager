const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeFile, makeFakeDuty, cleanup } = require("./helpers");
const modKnowledge = require("../src/services/modKnowledge");
const modRecognition = require("../src/services/modRecognition");
const modScanner = require("../src/services/modScanner");
const registry = require("../src/services/registry");
const smartInstall = require("../src/services/smartInstall");

function scanOf(dir) {
  return modScanner.scan(dir);
}

test("built-in knowledge database loads and validates", () => {
  const db = modKnowledge.load();
  assert.equal(db.schemaVersion, 1);
  assert.ok(db.mods.length > 0);
  assert.ok(modKnowledge.findById(db, "lspdfr"));
  assert.equal(modKnowledge.findById(db, "lspdfr").compatibility.gtaEnhanced, "UNKNOWN");
  assert.deepEqual(modKnowledge.findById(db, "ultimate-backup").dependencies, []);
});

test("malformed knowledge database falls back to empty catalog", () => {
  const parsed = modKnowledge.parseDatabase({ nope: true }, "TEST");
  assert.equal(parsed.mods.length, 0);
  assert.match(parsed.warning, /malformed/i);
});

test("DLL filename recognition is high-confidence for known plugins", () => {
  const payload = tmpDir("rec-");
  writeFile(payload, "plugins/LSPDFR/UltimateBackup.dll", "UB");
  writeFile(payload, "UltimateBackup.ini", "cfg");
  try {
    const result = modRecognition.recognize(scanOf(payload), {
      archiveName: "UltimateBackup-1.8.zip",
      classificationType: "LSPDFR_PLUGIN",
    });
    assert.equal(result.modId, "ultimate-backup");
    assert.equal(result.name, "Ultimate Backup");
    assert.ok(result.confidence >= 0.9);
    assert.equal(result.band, "HIGH");
    assert.ok(result.signals.some((s) => s.type === "DLL_NAME"));
    assert.ok(result.signals.some((s) => s.type === "ARCHIVE_PATTERN" || s.type === "ALIAS"));
  } finally {
    cleanup(payload);
  }
});

test("archive-name recognition without a DLL stays low or unknown", () => {
  const payload = tmpDir("rec-");
  writeFile(payload, "readme.txt", "junk is skipped");
  writeFile(payload, "notes.ini", "not a known config");
  try {
    const result = modRecognition.recognize(scanOf(payload), { archiveName: "UltimateBackup.zip" });
    assert.ok(result.confidence < 0.7);
    if (result.modId) assert.ok(["LOW", "UNKNOWN"].includes(result.band));
  } finally {
    cleanup(payload);
  }
});

test("folder-layout recognition contributes a folder-structure signal", () => {
  const payload = tmpDir("rec-");
  writeFile(payload, "plugins/LSPDFR/LSPD First Response.dll", "LSPDFR");
  try {
    const result = modRecognition.recognize(scanOf(payload), {
      archiveName: "lspdfr_049.zip",
      classificationType: "LSPDFR_PLUGIN",
    });
    assert.equal(result.modId, "lspdfr");
    assert.ok(result.signals.some((s) => s.type === "FOLDER_PATTERN" || s.type === "DLL_NAME"));
    assert.ok(result.confidence >= 0.7);
  } finally {
    cleanup(payload);
  }
});

test("unknown pack is not invented as a known mod", () => {
  const payload = tmpDir("rec-");
  writeFile(payload, "plugins/LSPDFR/TotallyNewCallout.dll", "NEW");
  try {
    const result = modRecognition.recognize(scanOf(payload), {
      archiveName: "TotallyNewCallout.zip",
      classificationType: "LSPDFR_PLUGIN",
    });
    assert.ok(result.confidence < 0.4 || result.modId !== "ultimate-backup");
    if (result.band === "UNKNOWN") assert.ok(!result.modId || result.confidence < 0.4);
    assert.notEqual(result.modId, "ultimate-backup");
  } finally {
    cleanup(payload);
  }
});

test("alias and archive patterns recognize ScriptHookVDotNet", () => {
  const payload = tmpDir("rec-");
  writeFile(payload, "ScriptHookVDotNet.asi", "ASI");
  writeFile(payload, "ScriptHookVDotNet3.dll", "DLL");
  try {
    const result = modRecognition.recognize(scanOf(payload), {
      archiveName: "ScriptHookVDotNet-v3.7.0.zip",
    });
    assert.equal(result.modId, "scripthookvdotnet");
    assert.ok(result.confidence >= 0.7);
    assert.ok(result.signals.some((s) => s.type === "DLL_NAME"));
  } finally {
    cleanup(payload);
  }
});

test("duplicate detection finds an already-installed known DLL", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPDFR/UltimateBackup.dll", "OLD");
  registry.add(duty, {
    id: "ub-old",
    name: "UltimateBackup",
    version: "1.7.0",
    enabled: true,
    files: ["plugins\\LSPDFR\\UltimateBackup.dll"],
  });
  const payload = tmpDir("rec-");
  writeFile(payload, "UltimateBackup.dll", "NEW");
  try {
    const recognition = modRecognition.recognize(scanOf(payload), { archiveName: "UltimateBackup.zip" });
    const dup = modRecognition.detectInstalled(recognition, {
      dutyPath: duty,
      droppedVersion: "1.8.0",
    });
    assert.equal(dup.alreadyInstalled, true);
    assert.equal(dup.possibleUpdate, true);
    assert.equal(dup.installed.version, "1.7.0");
    assert.equal(dup.dropped.version, "1.8.0");
  } finally {
    cleanup(duty, payload);
  }
});

test("unknown recognition is not treated as a duplicate", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPDFR/Other.dll", "X");
  const payload = tmpDir("rec-");
  writeFile(payload, "Weird.dll", "Y");
  try {
    const recognition = modRecognition.recognize(scanOf(payload), { archiveName: "Weird.zip" });
    const dup = modRecognition.detectInstalled(recognition, { dutyPath: duty });
    assert.equal(dup.alreadyInstalled, false);
  } finally {
    cleanup(duty, payload);
  }
});

test("smart analyze attaches recognition without changing install mapping", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/StopThePed.dll", "STP");
  try {
    const preview = await smartInstall.analyze({
      source: payload,
      dutyPath: duty,
      dataDir,
      stagingRoot: staging,
    });
    assert.equal(preview.recognition.modId, "stop-the-ped");
    assert.ok(["GOOD", "HIGH"].includes(preview.recognition.band));
    const dll = preview.files.find((f) => f.destination.endsWith("StopThePed.dll"));
    assert.equal(dll.destination, "plugins/LSPDFR/StopThePed.dll");
    assert.equal(preview.duplicate.alreadyInstalled, false);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("user knowledge file is optional and source files stay static", () => {
  const userDir = tmpDir("user-k-");
  const userPath = path.join(userDir, "mods.json");
  fs.writeFileSync(
    userPath,
    JSON.stringify({
      schemaVersion: 1,
      mods: [
        {
          id: "custom-test-mod",
          name: "Custom Test Mod",
          aliases: [],
          category: "LSPDFR_PLUGIN",
          recognition: { dllNames: ["CustomTestMod.dll"], archivePatterns: [], folderPatterns: [], configNames: [], readmeTerms: [] },
        },
      ],
    })
  );
  const payload = tmpDir("rec-");
  writeFile(payload, "CustomTestMod.dll", "X");
  try {
    const db = modKnowledge.load({ userPath });
    assert.ok(modKnowledge.findById(db, "custom-test-mod"));
    const result = modRecognition.recognize(scanOf(payload), {
      archiveName: "CustomTestMod.zip",
      database: db,
    });
    assert.equal(result.modId, "custom-test-mod");
    assert.ok(!fs.existsSync(path.join(__dirname, "..", "src", "data", "userKnowledge.json")));
  } finally {
    cleanup(userDir, payload);
  }
});
