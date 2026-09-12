const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, cleanup, cloneArchiveFixture } = require("./helpers");
const archive = require("../src/services/archive/gtaArchiveService");
const mock = require("../src/services/archive/mockArchiveBackend");
const { BACKEND_METHODS, assertBackendContract, isRealRpfPath } = require("../src/services/archive/archiveBackend");
const { validateManifest } = require("../src/services/manifestValidate");
const { readAudit } = require("../src/services/smartAudit");

function writeOpts(dataDir) {
  return { dataDir, allowMockWrites: true };
}

function hashFile(dir) {
  const handle = archive.openArchive(dir, { readOnly: true });
  try {
    return archive.hashArchive(handle);
  } finally {
    archive.close(handle);
  }
}

function readUtf8(dir, entry) {
  const handle = archive.openArchive(dir, { readOnly: true });
  try {
    return archive.readEntry(handle, entry).toString("utf8");
  } finally {
    archive.close(handle);
  }
}

test("backend interface and mock capabilities", () => {
  assert.equal(assertBackendContract(mock), true);
  for (const name of BACKEND_METHODS) assert.equal(typeof mock[name], "function");
  const caps = archive.getCapabilities();
  assert.equal(caps.read, true);
  assert.equal(caps.write, false);
  assert.equal(caps.add, false);
  assert.equal(caps.replace, false);
  assert.equal(caps.remove, false);
  assert.equal(caps.transactional, false);
  assert.equal(caps.realGtaArchives, true);
  assert.equal(caps.writeEnabled, false);
  assert.equal(caps.mode, "READ_ONLY");
  assert.equal(caps.mock.realGtaArchives, false);
  assert.equal(caps.mock.write, true);
  assert.equal(caps.mock.transactional, true);
  assert.equal(caps.nativeWritesEnabled, false);
  assert.equal(archive.ENABLE_NATIVE_ARCHIVE_WRITES, false);
});

test("mock archive open, list, read, metadata, and hashing", () => {
  const dir = cloneArchiveFixture("vehicles");
  const handle = archive.openArchive(dir);
  try {
    const entries = archive.listEntries(handle);
    assert.deepEqual(entries, [
      "x64/levels/gta5/vehicles/police.yft",
      "x64/levels/gta5/vehicles/police.ytd",
      "x64/levels/gta5/vehicles/police_hi.yft",
    ]);
    assert.equal(archive.entryExists(handle, "x64/levels/gta5/vehicles/police.yft"), true);
    assert.equal(archive.readEntry(handle, "x64/levels/gta5/vehicles/police.yft").toString("utf8"), "dummy-police-yft");
    const meta = archive.getEntryMetadata(handle, "x64/levels/gta5/vehicles/police.ytd");
    assert.equal(meta.exists, true);
    assert.equal(meta.size, "dummy-police-ytd".length);
    assert.match(meta.hash, /^[a-f0-9]{64}$/);
    const hash = archive.hashArchive(handle);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash, archive.hashArchive(handle));
  } finally {
    archive.close(handle);
    cleanup(dir);
  }
});

test("mock add, replace, and remove persist on commit", () => {
  const dir = cloneArchiveFixture("dlc");
  const handle = archive.openArchive(dir);
  try {
    archive.addEntry(handle, "dlc/vehicles/police3.yft", "dummy-police3");
    archive.replaceEntry(handle, "dlc/vehicles/police2.yft", "dummy-dlc-police2-yft-v2");
    archive.removeEntry(handle, "dlc/common/data/handling.meta");
    archive.validate(handle);
    archive.commit(handle);
  } finally {
    archive.close(handle);
  }
  const verify = archive.openArchive(dir, { readOnly: true });
  try {
    assert.equal(archive.entryExists(verify, "dlc/vehicles/police3.yft"), true);
    assert.equal(archive.readEntry(verify, "dlc/vehicles/police2.yft").toString("utf8"), "dummy-dlc-police2-yft-v2");
    assert.equal(archive.entryExists(verify, "dlc/common/data/handling.meta"), false);
  } finally {
    archive.close(verify);
    cleanup(dir);
  }
});

test("plan is read-only and does not change the mock archive", () => {
  const dir = cloneArchiveFixture("vehicles");
  const before = hashFile(dir);
  const raw = fs.readFileSync(path.join(dir, "archive.json"), "utf8");
  const plan = archive.createPlan({
    archivePath: dir,
    installId: "install-a",
    analysisId: "analysis-1",
    canonicalModId: "mock-police",
    operations: [
      {
        action: "REPLACE",
        entryPath: "x64/levels/gta5/vehicles/police.yft",
        bytes: "mod-a-police",
      },
    ],
  });
  assert.equal(plan.archiveHash, before);
  assert.equal(hashFile(dir), before);
  assert.equal(fs.readFileSync(path.join(dir, "archive.json"), "utf8"), raw);
  assert.equal(plan.operations[0].action, "REPLACE");
  assert.match(plan.operations[0].sourceHash, /^[a-f0-9]{64}$/);
  cleanup(dir);
});

test("stale archive detection rejects apply with STATE_CHANGED", () => {
  const dir = cloneArchiveFixture("vehicles");
  const dataDir = tmpDir("archive-data-");
  const plan = archive.createPlan({
    archivePath: dir,
    installId: "install-a",
    analysisId: "analysis-stale",
    operations: [
      { action: "REPLACE", entryPath: "x64/levels/gta5/vehicles/police.yft", bytes: "mod-a" },
    ],
  });
  const dirty = archive.openArchive(dir);
  archive.replaceEntry(dirty, "x64/levels/gta5/vehicles/police.yft", "external-edit");
  archive.commit(dirty);
  archive.close(dirty);
  const beforeApply = hashFile(dir);
  assert.throws(
    () => archive.applyPlan(plan, writeOpts(dataDir)),
    (err) => err.code === "STATE_CHANGED"
  );
  assert.equal(hashFile(dir), beforeApply);
  cleanup(dir, dataDir);
});

test("successful commit, backup metadata, and audit events", () => {
  const dir = cloneArchiveFixture("vehicles");
  const dataDir = tmpDir("archive-data-");
  const before = hashFile(dir);
  const plan = archive.createPlan({
    archivePath: dir,
    dataDir,
    installId: "install-a",
    analysisId: "analysis-ok",
    canonicalModId: "mock-police",
    operations: [
      { action: "REPLACE", entryPath: "x64/levels/gta5/vehicles/police.yft", bytes: "mod-a-police" },
      { action: "ADD", entryPath: "x64/levels/gta5/vehicles/police_new.yft", bytes: "brand-new" },
    ],
  });
  const result = archive.applyPlan(plan, writeOpts(dataDir));
  assert.equal(result.state, "COMMITTED");
  assert.equal(result.archiveHashBefore, before);
  assert.notEqual(result.archiveHashAfter, before);
  assert.equal(readUtf8(dir, "x64/levels/gta5/vehicles/police.yft"), "mod-a-police");
  const tx = archive.loadTransaction(dataDir, result.archiveTransactionId);
  assert.equal(tx.state, "COMMITTED");
  assert.equal(tx.backup.archiveOriginalHash, before);
  assert.ok(tx.backup.archiveOriginalSize > 0);
  assert.ok(tx.backup.backupPath.includes(result.archiveTransactionId));
  assert.ok(fs.existsSync(path.join(tx.backup.backupPath, "archive.json")));
  const events = readAudit(dataDir).map((row) => row.event);
  for (const name of [
    "ARCHIVE_PLAN_CREATED",
    "ARCHIVE_BACKUP_CREATED",
    "ARCHIVE_APPLY_STARTED",
    "ARCHIVE_ENTRY_REPLACED",
    "ARCHIVE_ENTRY_ADDED",
    "ARCHIVE_VALIDATED",
    "ARCHIVE_COMMITTED",
  ]) {
    assert.ok(events.includes(name), name);
  }
  cleanup(dir, dataDir);
});

test("validation failure rolls back to the exact pre-transaction archive", () => {
  const dir = cloneArchiveFixture("vehicles");
  const dataDir = tmpDir("archive-data-");
  const before = hashFile(dir);
  const plan = archive.createPlan({
    archivePath: dir,
    dataDir,
    installId: "install-a",
    operations: [{ action: "REPLACE", entryPath: "x64/levels/gta5/vehicles/police.yft", bytes: "bad-apply" }],
  });
  assert.throws(
    () => archive.applyPlan(plan, { ...writeOpts(dataDir), hooks: { failValidate: true } }),
    (err) => err.code === "VALIDATION_FAILED"
  );
  assert.equal(hashFile(dir), before);
  assert.equal(readUtf8(dir, "x64/levels/gta5/vehicles/police.yft"), "dummy-police-yft");
  const events = readAudit(dataDir).map((row) => row.event);
  assert.ok(events.includes("ARCHIVE_ROLLBACK_STARTED"));
  assert.ok(events.includes("ARCHIVE_ROLLBACK_COMPLETED"));
  cleanup(dir, dataDir);
});

test("ownership first install records VANILLA then the new owner", () => {
  const dir = cloneArchiveFixture("vehicles");
  const dataDir = tmpDir("archive-data-");
  const entry = "x64/levels/gta5/vehicles/police.yft";
  const plan = archive.createPlan({
    archivePath: dir,
    dataDir,
    installId: "install-a",
    analysisId: "a1",
    operations: [{ action: "REPLACE", entryPath: entry, bytes: "mod-a" }],
  });
  archive.applyPlan(plan, writeOpts(dataDir));
  const inspect = archive.inspectEntry(dataDir, dir, entry);
  assert.equal(inspect.currentOwner, "install-a");
  assert.equal(inspect.status, "OK");
  assert.equal(inspect.history[0].owner, archive.VANILLA);
  assert.equal(inspect.history[1].owner, "install-a");
  assert.equal(readUtf8(dir, entry), "mod-a");
  cleanup(dir, dataDir);
});

test("ownership second install stacks and remove top restores previous owner", () => {
  const dir = cloneArchiveFixture("vehicles");
  const dataDir = tmpDir("archive-data-");
  const entry = "x64/levels/gta5/vehicles/police.yft";
  archive.applyPlan(
    archive.createPlan({
      archivePath: dir,
      dataDir,
      installId: "install-a",
      operations: [{ action: "REPLACE", entryPath: entry, bytes: "mod-a" }],
    }),
    writeOpts(dataDir)
  );
  archive.applyPlan(
    archive.createPlan({
      archivePath: dir,
      dataDir,
      installId: "install-b",
      operations: [{ action: "REPLACE", entryPath: entry, bytes: "mod-b" }],
    }),
    writeOpts(dataDir)
  );
  const stacked = archive.inspectEntry(dataDir, dir, entry);
  assert.equal(stacked.currentOwner, "install-b");
  assert.deepEqual(
    stacked.history.map((row) => row.owner),
    [archive.VANILLA, "install-a", "install-b"]
  );
  archive.applyOwnerRelease({
    dataDir,
    archivePath: dir,
    entryPath: entry,
    installId: "install-b",
    allowMockWrites: true,
  });
  assert.equal(readUtf8(dir, entry), "mod-a");
  assert.equal(archive.inspectEntry(dataDir, dir, entry).currentOwner, "install-a");
  cleanup(dir, dataDir);
});

test("remove final owner restores VANILLA", () => {
  const dir = cloneArchiveFixture("vehicles");
  const dataDir = tmpDir("archive-data-");
  const entry = "x64/levels/gta5/vehicles/police.yft";
  archive.applyPlan(
    archive.createPlan({
      archivePath: dir,
      dataDir,
      installId: "install-a",
      operations: [{ action: "REPLACE", entryPath: entry, bytes: "mod-a" }],
    }),
    writeOpts(dataDir)
  );
  archive.applyOwnerRelease({
    dataDir,
    archivePath: dir,
    entryPath: entry,
    installId: "install-a",
    allowMockWrites: true,
  });
  assert.equal(readUtf8(dir, entry), "dummy-police-yft");
  assert.equal(archive.inspectEntry(dataDir, dir, entry).currentOwner, archive.VANILLA);
  cleanup(dir, dataDir);
});

test("external modification is detected and not overwritten", () => {
  const dir = cloneArchiveFixture("vehicles");
  const dataDir = tmpDir("archive-data-");
  const entry = "x64/levels/gta5/vehicles/police.yft";
  archive.applyPlan(
    archive.createPlan({
      archivePath: dir,
      dataDir,
      installId: "install-a",
      operations: [{ action: "REPLACE", entryPath: entry, bytes: "mod-a" }],
    }),
    writeOpts(dataDir)
  );
  const dirty = archive.openArchive(dir);
  archive.replaceEntry(dirty, entry, "hand-edited");
  archive.commit(dirty);
  archive.close(dirty);
  const inspect = archive.inspectEntry(dataDir, dir, entry);
  assert.equal(inspect.status, "EXTERNALLY_MODIFIED");
  assert.throws(
    () =>
      archive.applyPlan(
        archive.createPlan({
          archivePath: dir,
          dataDir,
          installId: "install-b",
          operations: [{ action: "REPLACE", entryPath: entry, bytes: "mod-b" }],
        }),
        writeOpts(dataDir)
      ),
    (err) => err.code === "EXTERNALLY_MODIFIED"
  );
  assert.equal(readUtf8(dir, entry), "hand-edited");
  cleanup(dir, dataDir);
});

test("manifest archive operations stay on the V2 schema", () => {
  const checked = validateManifest({
    id: "install-a",
    files: [{ destination: "plugins/foo.dll", action: "add", hash: "abc" }],
    archiveOperations: [
      {
        archive: "vehicles.rpf",
        entry: "x64/levels/gta5/vehicles/police.yft",
        action: "REPLACE",
        previousHash: "aaa",
        newHash: "bbb",
        transactionId: "tx-1",
      },
    ],
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.manifest.schemaVersion, 1);
  assert.equal(checked.manifest.archiveOperations.length, 1);
  const attached = archive.withArchiveOperations(
    { id: "install-a", files: [], schemaVersion: 1 },
    {
      archiveTransactionId: "tx-2",
      plan: {
        archiveName: "vehicles.rpf",
        operations: [
          {
            action: "REPLACE",
            entryPath: "vehicles/police.yft",
            expectedCurrentHash: "old",
            sourceHash: "new",
          },
        ],
      },
    }
  );
  assert.equal(attached.archiveOperations[0].transactionId, "tx-2");
  assert.equal(attached.archiveOperations[0].action, "REPLACE");
});

test("real .rpf paths are rejected without parsing", () => {
  const dir = tmpDir("fake-rpf-");
  const rpf = path.join(dir, "vehicles.rpf");
  fs.writeFileSync(rpf, Buffer.from("NOT-A-REAL-RPF"));
  assert.equal(isRealRpfPath(rpf), true);
  assert.throws(
    () => archive.openArchive(rpf),
    (err) => err.code === "INVALID_RPF"
  );
  assert.throws(
    () =>
      archive.applyPlan(
        {
          archivePath: rpf,
          archiveTransactionId: "tx-rpf",
          archiveHash: "x",
          archiveName: "vehicles.rpf",
          operations: [],
        },
        { dataDir: dir, allowMockWrites: true }
      ),
    (err) => err.code === "NATIVE_RPF_WRITES_NOT_ENABLED"
  );
  cleanup(dir);
});

test("feature flag blocks production writes", () => {
  const dir = cloneArchiveFixture("vehicles");
  const dataDir = tmpDir("archive-data-");
  const before = hashFile(dir);
  const plan = archive.createPlan({
    archivePath: dir,
    installId: "install-a",
    operations: [{ action: "REPLACE", entryPath: "x64/levels/gta5/vehicles/police.yft", bytes: "nope" }],
  });
  assert.throws(
    () => archive.applyPlan(plan, { dataDir, allowMockWrites: false }),
    (err) => err.code === "NATIVE_RPF_WRITES_NOT_ENABLED"
  );
  assert.equal(archive.ENABLE_NATIVE_ARCHIVE_WRITES, false);
  assert.equal(hashFile(dir), before);
  cleanup(dir, dataDir);
});

test("corrupted mock archive is rejected", () => {
  const dir = cloneArchiveFixture("corrupted");
  assert.throws(() => archive.openArchive(dir), (err) => err.code === "ARCHIVE_ERROR");
  cleanup(dir);
});

test("interrupted transactions recover to the pre-transaction archive", () => {
  const cases = [
    { interruptAfter: "BACKUP", label: "after backup" },
    { interruptAfter: "FIRST_WRITE", label: "after first write" },
    { interruptAfter: "VALIDATION", label: "during validation" },
    { interruptAfter: "ROLLBACK", label: "during rollback", failValidate: true },
  ];
  for (const spec of cases) {
    const dir = cloneArchiveFixture("vehicles");
    const dataDir = tmpDir("archive-data-");
    const before = hashFile(dir);
    const plan = archive.createPlan({
      archivePath: dir,
      dataDir,
      installId: "install-a",
      operations: [
        { action: "REPLACE", entryPath: "x64/levels/gta5/vehicles/police.yft", bytes: "partial-write" },
        { action: "ADD", entryPath: "x64/levels/gta5/vehicles/extra.yft", bytes: "extra" },
      ],
    });
    assert.throws(
      () =>
        archive.applyPlan(plan, {
          ...writeOpts(dataDir),
          hooks: { interruptAfter: spec.interruptAfter, failValidate: spec.failValidate },
        }),
      (err) => err.code === "INTERRUPTED"
    );
    const found = archive.scanRecovery(dataDir);
    assert.equal(found.length, 1, spec.label);
    assert.equal(found[0].action, "RESTORE_BACKUP");
    const recovered = archive.recover(dataDir, found[0].archiveTransactionId);
    assert.equal(recovered.action, "RESTORE_BACKUP");
    assert.equal(recovered.state, "ROLLED_BACK");
    assert.equal(hashFile(dir), before, spec.label);
    cleanup(dir, dataDir);
  }
});

test("chaos: 20 operations fail on 13 and restore archive plus ownership", () => {
  const dir = tmpDir("chaos-archive-");
  const dataDir = tmpDir("archive-data-");
  const entries = {};
  for (let i = 1; i <= 30; i += 1) entries[`slot/file-${String(i).padStart(2, "0")}.bin`] = `vanilla-${i}`;
  mock.writeMockArchive(path.join(dir, "archive.json"), "chaos.rpf", entries);

  const seed = archive.createPlan({
    archivePath: dir,
    dataDir,
    installId: "install-seed",
    operations: [{ action: "REPLACE", entryPath: "slot/file-01.bin", bytes: "owned-before-chaos" }],
  });
  archive.applyPlan(seed, writeOpts(dataDir));

  const beforeHash = hashFile(dir);
  const beforeOwnership = archive.cloneOwnership(archive.loadOwnership(dataDir));
  const operations = [];
  for (let i = 1; i <= 20; i += 1) {
    operations.push({
      action: "REPLACE",
      entryPath: `slot/file-${String(i).padStart(2, "0")}.bin`,
      bytes: `chaos-${i}`,
    });
  }
  const plan = archive.createPlan({
    archivePath: dir,
    dataDir,
    installId: "install-chaos",
    operations,
  });
  assert.throws(
    () => archive.applyPlan(plan, { ...writeOpts(dataDir), hooks: { failAtOperation: 13 } }),
    (err) => /Forced failure on archive operation 13/.test(err.message)
  );
  assert.equal(hashFile(dir), beforeHash);
  assert.equal(archive.ownershipEquals(archive.loadOwnership(dataDir), beforeOwnership), true);
  assert.equal(readUtf8(dir, "slot/file-01.bin"), "owned-before-chaos");
  cleanup(dir, dataDir);
});
