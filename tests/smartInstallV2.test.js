const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeFile, readFile, fileExists, makeFakeDuty, cleanup } = require("./helpers");
const smartInstall = require("../src/services/smartInstall");
const manifestStore = require("../src/services/manifestStore");
const { fingerprintPath } = require("../src/services/packageFingerprint");
const { applyConfigPolicy, isConfigFile } = require("../src/services/configPolicy");
const { validateManifest } = require("../src/services/manifestValidate");
const { diagnoseManagedMod } = require("../src/services/orphanDetector");
const { readMetrics, readAudit } = require("../src/services/smartAudit");
const modRecognition = require("../src/services/modRecognition");
const modKnowledge = require("../src/services/modKnowledge");
const modScanner = require("../src/services/modScanner");

function ctx() {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  return { duty, dataDir, staging };
}

function treeHash(root) {
  return fingerprintPath(root);
}

test("known mod + safe mapping gets analysis identity and fingerprint", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/StopThePed.dll", "STP");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    assert.ok(preview.analysisId);
    assert.ok(preview.installId);
    assert.equal(preview.canonicalModId, "stop-the-ped");
    assert.ok(preview.sourceArchiveHash);
    assert.ok(preview.environmentSnapshot.stagedHash);
    assert.equal(preview.recognition.band === "HIGH" || preview.recognition.band === "GOOD", true);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("unknown mod + safe mapping stays installable", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/TotallyUnknownCallout.dll", "X");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    assert.equal(preview.canonicalModId, null);
    assert.equal(preview.recognition.band, "UNKNOWN");
    assert.notEqual(preview.recommendation.status, "BLOCKED");
    const dll = preview.files.find((f) => f.destination.endsWith("TotallyUnknownCallout.dll"));
    assert.equal(dll.action, "add");
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("known mod + missing required dependency is not blocked", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Callout.dll", "needs LemonUI token in bytes LemonUI");
  writeFile(payload, "README.txt", "Requires LemonUI");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    const lemon = (preview.resolvedDependencies || []).find((d) => d.modId === "lemonui");
    assert.ok(lemon);
    assert.notEqual(preview.recommendation.status, "BLOCKED");
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("README-only dependency stays low-trust evidence", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Callout.dll", "plain");
  writeFile(payload, "README.txt", "Requires LemonUI");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    const lemon = preview.readmeEvidence.find((d) => d.modId === "lemonui");
    assert.ok(lemon);
    assert.equal(lemon.source, "README");
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("package executable is skipped and never run", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Ok.dll", "OK");
  writeFile(payload, "setup.exe", "EXE");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    const exe = preview.files.find((f) => f.source.toLowerCase().endsWith("setup.exe"));
    assert.equal(exe.action, "skip");
    assert.ok(preview.executables.length);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("low-confidence recognition does not claim identity", () => {
  const db = modKnowledge.parseDatabase(
    {
      schemaVersion: 1,
      mods: [
        {
          id: "maybe-mod",
          name: "Maybe Mod",
          aliases: ["maybe"],
          category: "LSPDFR_PLUGIN",
          recognition: { dllNames: [], archivePatterns: ["maybe"], folderPatterns: [], configNames: [] },
        },
      ],
    },
    "TEST"
  );
  const payload = tmpDir("rec-");
  writeFile(payload, "notes.ini", "x");
  try {
    const result = modRecognition.recognize(modScanner.scan(payload), {
      archiveName: "maybe-pack.zip",
      classificationType: "LSPDFR_PLUGIN",
      database: db,
    });
    assert.equal(result.modId, null);
    assert.ok(result.confidence < 0.7);
  } finally {
    cleanup(payload);
  }
});

test("ambiguous recognition does not silently pick", () => {
  const db = modKnowledge.parseDatabase(
    {
      schemaVersion: 1,
      mods: [
        {
          id: "mod-a",
          name: "Mod A",
          aliases: [],
          category: "LSPDFR_PLUGIN",
          recognition: { dllNames: ["SharedName.dll"], archivePatterns: [], folderPatterns: [], configNames: [] },
        },
        {
          id: "mod-b",
          name: "Mod B",
          aliases: [],
          category: "LSPDFR_PLUGIN",
          recognition: { dllNames: ["SharedName.dll"], archivePatterns: [], folderPatterns: [], configNames: [] },
        },
      ],
    },
    "TEST"
  );
  const payload = tmpDir("rec-");
  writeFile(payload, "SharedName.dll", "X");
  try {
    const result = modRecognition.recognize(modScanner.scan(payload), {
      archiveName: "SharedName.zip",
      database: db,
    });
    assert.equal(result.ambiguous, true);
    assert.equal(result.modId, null);
    assert.ok(result.candidates.length >= 2);
  } finally {
    cleanup(payload);
  }
});

test("same version installed reuses installId", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/StopThePed.dll", "STP");
  try {
    const first = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    const manifest = await smartInstall.commit({ preview: first, dutyPath: duty, dataDir });
    const second = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    assert.equal(second.duplicate.alreadyInstalled, true);
    assert.equal(second.installId, manifest.id);
    assert.equal(second.duplicate.relation === "SAME" || second.duplicate.relation === "UNKNOWN", true);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("newer and older relations are detected", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPDFR/UltimateBackup.dll", "OLD");
  const registry = require("../src/services/registry");
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
    const recognition = modRecognition.recognize(modScanner.scan(payload), { archiveName: "UltimateBackup.zip" });
    const newer = modRecognition.detectInstalled(recognition, { dutyPath: duty, droppedVersion: "1.8.0" });
    const older = modRecognition.detectInstalled(recognition, { dutyPath: duty, droppedVersion: "1.6.0" });
    const same = modRecognition.detectInstalled(recognition, { dutyPath: duty, droppedVersion: "1.7.0" });
    assert.equal(newer.relation, "UPDATE");
    assert.equal(older.relation, "DOWNGRADE");
    assert.equal(same.relation, "SAME");
  } finally {
    cleanup(duty, payload);
  }
});

test("stale Duty change blocks commit with STATE_CHANGED", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(duty, "plugins/LSPDFR/Cool.dll", "OLD");
  writeFile(payload, "plugins/LSPDFR/Cool.dll", "NEW");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    writeFile(duty, "plugins/LSPDFR/Cool.dll", "CHANGED-AFTER-PREVIEW");
    await assert.rejects(() => smartInstall.commit({ preview, dutyPath: duty, dataDir }), (error) => {
      assert.equal(error.category, "STATE_CHANGED");
      return true;
    });
    assert.equal(readFile(duty, "plugins/LSPDFR/Cool.dll"), "CHANGED-AFTER-PREVIEW");
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("staged package hash change rejects commit", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Cool.dll", "A");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    writeFile(preview.payloadRoot, "plugins/LSPDFR/Cool.dll", "B");
    await assert.rejects(() => smartInstall.commit({ preview, dutyPath: duty, dataDir }), (error) => {
      assert.equal(error.category, "STATE_CHANGED");
      return true;
    });
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("preserve existing config by default", async () => {
  const { duty, dataDir, staging } = ctx();
  const first = tmpDir("p1-");
  writeFile(first, "plugins/LSPDFR/StopThePed.dll", "V1");
  writeFile(first, "StopThePed.ini", "old=1");
  const second = tmpDir("p2-");
  writeFile(second, "plugins/LSPDFR/StopThePed.dll", "V2");
  writeFile(second, "StopThePed.ini", "new=2");
  try {
    const a = await smartInstall.analyze({ source: first, dutyPath: duty, dataDir, stagingRoot: staging });
    await smartInstall.commit({ preview: a, dutyPath: duty, dataDir });
    writeFile(duty, "StopThePed.ini", "user=kept");
    const b = await smartInstall.analyze({ source: second, dutyPath: duty, dataDir, stagingRoot: staging });
    const ini = b.files.find((f) => /stoptheped\.ini$/i.test(f.destination));
    assert.ok(ini);
    assert.equal(ini.action, "skip");
    assert.equal(b.configPolicy, "KEEP_EXISTING");
    await smartInstall.commit({ preview: b, dutyPath: duty, dataDir });
    assert.equal(readFile(duty, "StopThePed.ini"), "user=kept");
  } finally {
    cleanup(duty, dataDir, staging, first, second);
  }
});

test("USE_NEW_DEFAULT replaces config", () => {
  const duty = makeFakeDuty();
  const payload = tmpDir("cfg-");
  writeFile(duty, "Cool.ini", "old");
  writeFile(payload, "Cool.ini", "new");
  try {
    const applied = applyConfigPolicy(
      [{ source: "Cool.ini", destination: "Cool.ini", action: "replace" }],
      { dutyPath: duty, payloadRoot: payload, policy: "USE_NEW_DEFAULT" }
    );
    assert.equal(applied.files[0].action, "replace");
    assert.equal(isConfigFile("Cool.ini"), true);
  } finally {
    cleanup(duty, payload);
  }
});

test("incoming new config is installed when missing", () => {
  const duty = makeFakeDuty();
  const payload = tmpDir("cfg-");
  writeFile(payload, "Fresh.ini", "fresh");
  try {
    const applied = applyConfigPolicy(
      [{ source: "Fresh.ini", destination: "Fresh.ini", action: "add" }],
      { dutyPath: duty, payloadRoot: payload, policy: "KEEP_EXISTING" }
    );
    assert.equal(applied.files[0].action, "add");
  } finally {
    cleanup(duty, payload);
  }
});

test("rollback chaos restores the exact pre-install tree", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  for (let i = 0; i < 10; i += 1) writeFile(payload, `plugins/LSPDFR/F${i}.dll`, `BODY-${i}`);
  const before = treeHash(duty);
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    await assert.rejects(() => smartInstall.commit({ preview, dutyPath: duty, dataDir, hooks: { failAtCopy: 5 } }), /rolled back/i);
    assert.equal(treeHash(duty), before);
    assert.equal(smartInstall.list(dataDir).length, 0);
    for (let i = 0; i < 10; i += 1) assert.equal(fileExists(duty, `plugins/LSPDFR/F${i}.dll`), false);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("backup, manifest, and validation failures roll back", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(duty, "plugins/LSPDFR/Cool.dll", "OLD");
  writeFile(payload, "plugins/LSPDFR/Cool.dll", "NEW");
  writeFile(payload, "plugins/LSPDFR/Extra.dll", "E");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    await assert.rejects(() => smartInstall.commit({ preview, dutyPath: duty, dataDir, hooks: { failBackup: true } }), /rolled back/i);
    assert.equal(readFile(duty, "plugins/LSPDFR/Cool.dll"), "OLD");

    const preview2 = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    await assert.rejects(() => smartInstall.commit({ preview: preview2, dutyPath: duty, dataDir, hooks: { failManifest: true } }), /rolled back/i);
    assert.equal(readFile(duty, "plugins/LSPDFR/Cool.dll"), "OLD");
    assert.equal(fileExists(duty, "plugins/LSPDFR/Extra.dll"), false);

    const preview3 = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    await assert.rejects(() => smartInstall.commit({ preview: preview3, dutyPath: duty, dataDir, hooks: { failValidate: true } }), /rolled back/i);
    assert.equal(readFile(duty, "plugins/LSPDFR/Cool.dll"), "OLD");
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("malformed manifest is marked MANIFEST_ERROR and not deleted", () => {
  const dataDir = tmpDir("data-");
  fs.mkdirSync(path.join(dataDir, "manifests"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "manifests", "broken.json"), "{not json", "utf8");
  try {
    const listed = smartInstall.list(dataDir);
    assert.equal(listed[0].manifestStatus, "MANIFEST_ERROR");
    assert.equal(listed[0].cardHealth, "Broken");
    assert.equal(fs.existsSync(path.join(dataDir, "manifests", "broken.json")), true);
    assert.equal(validateManifest({ nope: true }).ok, false);
  } finally {
    cleanup(dataDir);
  }
});

test("orphan diagnosis and repair restore a stored file", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Cool.dll", "COOL");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
    fs.rmSync(path.join(duty, "plugins", "LSPDFR", "Cool.dll"), { force: true });
    const diagnosis = diagnoseManagedMod(manifestStore.read(dataDir, manifest.id), { dutyPath: duty, dataDir });
    assert.equal(diagnosis.status, "BROKEN");
    const repaired = smartInstall.repair({ modId: manifest.id, dutyPath: duty, dataDir });
    assert.ok(repaired.restored.includes("plugins/LSPDFR/Cool.dll"));
    assert.equal(readFile(duty, "plugins/LSPDFR/Cool.dll"), "COOL");
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("history and audit are written locally", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Cool.dll", "COOL");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
    await smartInstall.setEnabled({ modId: manifest.id, dutyPath: duty, dataDir, enabled: false });
    const stored = manifestStore.read(dataDir, manifest.id);
    assert.ok(stored.history.some((h) => h.event === "INSTALLED"));
    assert.ok(stored.history.some((h) => h.event === "DISABLED"));
    const audit = readAudit(dataDir);
    assert.ok(audit.some((row) => row.event === "ANALYZED"));
    assert.ok(audit.some((row) => row.event === "INSTALL_COMMITTED"));
    assert.equal(readMetrics(dataDir).successfulInstalls >= 1, true);
    assert.equal(stored.schemaVersion, 1);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("analysis does not write Duty files", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Cool.dll", "COOL");
  const before = treeHash(duty);
  try {
    await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    assert.equal(treeHash(duty), before);
    assert.equal(fileExists(duty, "plugins/LSPDFR/Cool.dll"), false);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});
