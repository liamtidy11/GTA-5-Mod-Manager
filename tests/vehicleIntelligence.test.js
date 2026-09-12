const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeFile, makeFakeDuty, cleanup, cloneArchiveFixture } = require("./helpers");
const modScanner = require("../src/services/modScanner");
const { analyzeVehiclePackage, applyGenericInstallerArchiveGuard } = require("../src/services/vehicle/vehiclePackageAnalyzer");
const { groupVehicleAssets } = require("../src/services/vehicle/vehicleAssetGrouper");
const { slotFromFilename } = require("../src/services/vehicle/vehicleSlotDetector");
const { classifyVehicle } = require("../src/services/vehicle/vehicleClassifier");
const { loadPathMap, resolveSlot, discoverSlotInIndex } = require("../src/services/vehicle/archivePathResolver");
const archive = require("../src/services/archive/gtaArchiveService");
const smartInstall = require("../src/services/smartInstall");
const installer = require("../src/services/installer");
const recommendationEngine = require("../src/services/recommendationEngine");

const TEST_MAP = path.join(__dirname, "fixtures", "vehicle-paths", "mock-enhanced.json");

function pack(files) {
  const root = tmpDir("vehicle-pack-");
  for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
  return root;
}

function analyzePack(files, options = {}) {
  const root = pack(files);
  const scan = modScanner.scan(root);
  const result = analyzeVehiclePackage(scan, { pathMap: TEST_MAP, ...options });
  return { root, scan, result };
}

test("single replacement vehicle with _hi model", () => {
  const { root, result } = analyzePack({
    "police3.yft": "m",
    "police3_hi.yft": "h",
    "police3.ytd": "t",
  });
  assert.equal(result.kind, "REPLACE_VEHICLE");
  assert.equal(result.displayType, "Vehicle Replacement");
  assert.equal(result.groups[0].slot, "police3");
  assert.equal(result.groups[0].confidence, "HIGH");
  assert.ok(result.groups[0].model);
  assert.ok(result.groups[0].highDetailModel);
  assert.ok(result.groups[0].texture);
  cleanup(root);
});

test("missing _hi model and missing texture are warnings", () => {
  const { root, result } = analyzePack({
    "police3.yft": "m",
    "police3.ytd": "t",
  });
  assert.ok(result.warnings.includes("police3: missing _hi.yft"));
  const noTex = analyzeVehiclePackage(modScanner.scan(pack({ "sheriff.yft": "m", "sheriff_hi.yft": "h" })), {
    pathMap: TEST_MAP,
  });
  assert.ok(noTex.warnings.includes("sheriff: missing .ytd"));
  cleanup(root);
});

test("vehicle pack with multiple replacement slots", () => {
  const { root, result } = analyzePack({
    "police.yft": "a",
    "police.ytd": "a",
    "police2.yft": "b",
    "police2.ytd": "b",
    "police3.yft": "c",
    "police3.ytd": "c",
  });
  assert.equal(result.kind, "VEHICLE_PACK");
  assert.deepEqual(
    result.groups.map((g) => g.slot),
    ["police", "police2", "police3"]
  );
  cleanup(root);
});

test("add-on vehicle structure is recognized and not installed", () => {
  const { root, result } = analyzePack({
    "dlcpacks/examplepack/content.xml": "<content/>",
    "dlcpacks/examplepack/setup2.xml": "<setup/>",
    "dlcpacks/examplepack/dlc.rpf": "NOT-A-REAL-RPF",
  });
  assert.equal(result.kind, "ADDON_VEHICLE");
  assert.equal(result.plan.addon.dlcPackage, "examplepack");
  assert.equal(result.plan.applied, false);
  assert.deepEqual(result.plan.addon.requiredFutureOperations, ["install DLC package", "update dlclist.xml"]);
  cleanup(root);
});

test("ambiguous mixed replacement and add-on package", () => {
  const { root, result } = analyzePack({
    "police3.yft": "m",
    "police3_hi.yft": "h",
    "police3.ytd": "t",
    "content.xml": "<content/>",
    "dlcpacks/mixed/setup2.xml": "<setup/>",
  });
  assert.equal(result.kind, "AMBIGUOUS_VEHICLE_PACKAGE");
  cleanup(root);
});

test("known emergency slots from filenames", () => {
  for (const slot of ["police", "police2", "police3", "sheriff", "fbi", "ambulance"]) {
    const hit = slotFromFilename(`${slot}.yft`);
    assert.equal(hit.slot, slot);
    assert.equal(hit.confidence, "HIGH");
  }
});

test("unknown slot stays UNKNOWN and is not guessed", () => {
  const { root, result } = analyzePack({
    "mycustom.yft": "m",
    "mycustom.ytd": "t",
  });
  assert.equal(result.kind, "UNKNOWN_VEHICLE_MOD");
  assert.equal(result.groups[0].slot, "mycustom");
  assert.equal(result.groups[0].confidence, "UNKNOWN");
  assert.equal(result.pathResolutions[0].status, "UNKNOWN");
  cleanup(root);
});

test("README slot evidence is medium and filename evidence wins", () => {
  const { root, result } = analyzePack({
    "police3.yft": "m",
    "police3.ytd": "t",
    "readme.txt": "Install as police2. Replace police2 only.",
  });
  const filename = result.slots.find((s) => s.slot === "police3");
  const readme = result.slots.find((s) => s.slot === "police2");
  assert.equal(filename.confidence, "HIGH");
  assert.equal(readme.confidence, "MEDIUM");
  assert.equal(result.groups[0].slot, "police3");
  cleanup(root);
});

test("meta detection, association, and duplicate detection", () => {
  const { root, result } = analyzePack({
    "police3.yft": "m",
    "police3.ytd": "t",
    "vehicles.meta": "<vehicles/>",
    "carvariations.meta": "<vars/>",
    "extra/vehicles.meta": "<dup/>",
  });
  const names = result.metas.files.map((m) => m.name);
  assert.ok(names.includes("vehicles.meta"));
  assert.ok(names.includes("carvariations.meta"));
  assert.ok(result.metas.associated.police3.includes("vehicles.meta"));
  assert.ok(result.metas.duplicates.includes("vehicles.meta"));
  cleanup(root);
});

test("path resolver: verified mock, unknown, ambiguous, unsupported", () => {
  assert.equal(resolveSlot("police3", { pathMap: TEST_MAP }).status, "VERIFIED");
  assert.equal(resolveSlot("police4", { pathMap: TEST_MAP }).status, "UNKNOWN");
  assert.equal(resolveSlot("ambiguouscar", { pathMap: TEST_MAP }).status, "AMBIGUOUS");
  assert.equal(resolveSlot("hydra", { pathMap: TEST_MAP }).status, "UNSUPPORTED");
  const production = loadPathMap();
  assert.equal(production.edition, "Enhanced");
  assert.deepEqual(production.vehicleSlots, {});
});

test("future discovery hook can mark a single index hit DISCOVERED", () => {
  const found = discoverSlotInIndex("police4", [
    { slot: "police4", archive: "vehicles.rpf", entry: "x64/levels/gta5/vehicles/police4.yft", entryBase: "x64/levels/gta5/vehicles" },
  ]);
  assert.equal(found.status, "DISCOVERED");
});

test("dry-run plan is read-only and does not apply", () => {
  const mockDir = cloneArchiveFixture("vehicles");
  const dataDir = tmpDir("archive-data-");
  const handle = archive.openArchive(mockDir, { readOnly: true });
  const before = archive.hashArchive(handle);
  archive.close(handle);

  const { root, result } = analyzePack(
    {
      "police.yft": "new-police",
      "police_hi.yft": "new-hi",
      "police.ytd": "new-ytd",
    },
    { dataDir, mockArchivePath: mockDir }
  );

  assert.equal(result.plan.mode, "DRY_RUN");
  assert.equal(result.plan.applied, false);
  assert.equal(result.plan.capability, "UNSUPPORTED");
  assert.match(result.plan.capabilityReason, /cannot yet install encrypted archive modifications/i);
  assert.equal(result.plan.archiveOperations.length, 3);
  assert.ok(result.plan.archiveOperations.every((op) => op.status === "READY" || op.status === "CONFLICT"));
  const afterHandle = archive.openArchive(mockDir, { readOnly: true });
  assert.equal(archive.hashArchive(afterHandle), before);
  archive.close(afterHandle);
  cleanup(root, mockDir, dataDir);
});

test("dry-run distinguishes vanilla, managed, and external modification", () => {
  const mockDir = cloneArchiveFixture("vehicles");
  const dataDir = tmpDir("archive-data-");
  const entry = "x64/levels/gta5/vehicles/police.yft";

  const vanilla = analyzePack({ "police.yft": "incoming" }, { dataDir, mockArchivePath: mockDir });
  assert.equal(vanilla.result.plan.archiveOperations[0].currentState, "VANILLA");
  cleanup(vanilla.root);

  archive.applyPlan(
    archive.createPlan({
      archivePath: mockDir,
      dataDir,
      installId: "mod-a",
      operations: [{ action: "REPLACE", entryPath: entry, bytes: "owned-by-a" }],
    }),
    { dataDir, allowMockWrites: true }
  );
  const managed = analyzePack({ "police.yft": "incoming-b" }, { dataDir, mockArchivePath: mockDir });
  assert.equal(managed.result.plan.archiveOperations[0].currentState, "MANAGED_MOD");
  assert.equal(managed.result.plan.archiveOperations[0].status, "CONFLICT");
  assert.ok(managed.result.plan.ownershipConflicts[0].message.includes("mod-a"));
  cleanup(managed.root);

  const dirty = archive.openArchive(mockDir);
  archive.replaceEntry(dirty, entry, "hand-edited");
  archive.commit(dirty);
  archive.close(dirty);
  const external = analyzePack({ "police.yft": "incoming-c" }, { dataDir, mockArchivePath: mockDir });
  assert.equal(external.result.plan.archiveOperations[0].currentState, "EXTERNALLY_MODIFIED");
  assert.equal(external.result.plan.archiveOperations[0].status, "CONFLICT");
  cleanup(external.root, mockDir, dataDir);
});

test("unknown Enhanced path stays UNKNOWN_TARGET", () => {
  const { root, result } = analyzePack({
    "police4.yft": "m",
    "police4_hi.yft": "h",
    "police4.ytd": "t",
  });
  assert.equal(result.kind, "REPLACE_VEHICLE");
  assert.ok(result.plan.archiveOperations.every((op) => op.status === "UNKNOWN_TARGET"));
  assert.match(result.preview.text, /ARCHIVE TARGET UNKNOWN/);
  cleanup(root);
});

test("archiveRequired guard and Smart Install stay unsupported", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  const source = pack({
    "police3.yft": "m",
    "police3_hi.yft": "h",
    "police3.ytd": "t",
    "vehicles.meta": "<vehicles/>",
  });
  const preview = await smartInstall.analyze({
    source,
    dutyPath: duty,
    dataDir,
    stagingRoot: staging,
    vehiclePathMap: TEST_MAP,
  });
  assert.equal(preview.archiveRequired, true);
  assert.equal(preview.type, "Vehicle Replacement");
  assert.equal(preview.recommendation.status, "UNSUPPORTED");
  assert.notEqual(preview.recommendation.status, "SAFE_TO_INSTALL");
  assert.equal(preview.installSafety.status, "UNSUPPORTED");
  assert.ok(preview.files.every((f) => f.action !== "add" && f.action !== "replace" || !f.source.endsWith(".yft")));
  assert.ok(preview.files.filter((f) => f.source.endsWith(".yft") || f.source.endsWith(".ytd")).every((f) => f.action === "skip"));
  await assert.rejects(
    () => smartInstall.commit({ preview, dutyPath: duty, dataDir }),
    (err) => err.category === "ARCHIVE_ERROR"
  );
  assert.equal(fs.existsSync(path.join(duty, "police3.yft")), false);
  cleanup(duty, dataDir, staging, source);
});

test("generic installer cannot copy archive vehicle assets", async () => {
  const source = pack({ "police3.yft": "m", "police3.ytd": "t" });
  const staging = tmpDir("staging-");
  await assert.rejects(
    () => installer.analyze(source, staging),
    /not enabled/i
  );
  const mixed = pack({
    "police3.yft": "m",
    "plugins/LSPDFR/Callout.dll": "dll",
  });
  const plan = await installer.analyze(mixed, staging);
  assert.ok(!plan.copies.some((c) => /\.yft$/i.test(c.from) || /\.yft$/i.test(c.to)));
  assert.ok(plan.copies.some((c) => /Callout\.dll$/i.test(c.from) || /Callout\.dll$/i.test(c.to)));
  cleanup(source, mixed, staging);
});

test("real .rpf filesystem path is still rejected", () => {
  const dir = tmpDir("fake-rpf-");
  const rpf = path.join(dir, "vehicles.rpf");
  fs.writeFileSync(rpf, Buffer.from("NOT-A-REAL-RPF"));
  assert.throws(
    () => archive.openArchive(rpf),
    (err) => err.code === "INVALID_RPF"
  );
  assert.equal(archive.getCapabilities().writeEnabled, false);
  assert.equal(archive.getCapabilities().write, false);
  cleanup(dir);
});

test("recommendation maps archive capability to UNSUPPORTED, not BLOCKED", () => {
  const safety = recommendationEngine.evaluateInstallSafety({
    files: [{ action: "skip", archiveRequired: true }],
    usableCount: 3,
    archiveRequired: true,
    archiveCapabilities: { realGtaArchives: false },
  });
  assert.equal(safety.status, "UNSUPPORTED");
  assert.ok(safety.findings.some((f) => f.code === "NATIVE_ARCHIVE_WRITES_UNAVAILABLE"));
  const rec = recommendationEngine.recommend({
    compatibility: { status: "UNKNOWN", findings: [] },
    installSafety: safety,
    recognition: { band: "UNKNOWN" },
  });
  assert.equal(rec.status, "UNSUPPORTED");
  assert.equal(rec.allowOverride, false);
});

test("grouping allows incomplete groups and duplicate textures", () => {
  const grouped = groupVehicleAssets([
    { rel: "police.yft", base: "police.yft" },
    { rel: "police.ytd", base: "police.ytd" },
    { rel: "alt/police.ytd", base: "police.ytd" },
  ]);
  assert.equal(grouped.groups[0].slot, "police");
  assert.ok(grouped.warnings.some((w) => /multiple textures/.test(w)));
});

test("classifyVehicle does not invent an installable type from empty scans", () => {
  const result = classifyVehicle({ groups: [], files: [] });
  assert.equal(result.detected, false);
  assert.equal(result.archiveRequired, false);
});

test("generic installer guard strips yft/ytd from copy lists", () => {
  const guarded = applyGenericInstallerArchiveGuard([
    { from: "police3.yft", to: "police3.yft" },
    { from: "plugins/LSPDFR/A.dll", to: "plugins/LSPDFR/A.dll" },
  ]);
  assert.equal(guarded.archiveRequired, true);
  assert.equal(guarded.copies.length, 1);
  assert.match(guarded.copies[0].from, /A\.dll$/);
});
