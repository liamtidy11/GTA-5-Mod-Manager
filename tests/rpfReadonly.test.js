// Phase 3C read-only tests. Archives are independently generated OPEN RPF7
// fixtures (dummy UTF-8 bytes). No Rockstar / GTA assets are used.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, cleanup } = require("./helpers");
const archive = require("../src/services/archive/gtaArchiveService");
const real = require("../src/services/archive/realRpfBackend");
const { writeOpenRpf7 } = require("../src/services/archive/openRpfFixture");
const { hashOfFile } = require("../src/services/archive/rpf7OpenReader");
const { RPF7_MAGIC, ENC_NG } = require("../src/services/archive/rpf7OpenFormat");
const {
  findVehicleSlot,
  findEntriesByName,
  discoverCached,
  loadCache,
} = require("../src/services/archive/archiveIndex");
const { resolveSlot } = require("../src/services/vehicle/archivePathResolver");
const { analyzeVehiclePackage } = require("../src/services/vehicle/vehiclePackageAnalyzer");
const modScanner = require("../src/services/modScanner");
const smartInstall = require("../src/services/smartInstall");
const { writeFile, makeFakeDuty } = require("./helpers");

function makeVehicleRpf(dir, extra = {}) {
  const file = path.join(dir, "vehicles.rpf");
  writeOpenRpf7(file, {
    "x64/levels/gta5/vehicles/police3.yft": "dummy-police3-yft",
    "x64/levels/gta5/vehicles/police3_hi.yft": "dummy-police3-hi",
    "x64/levels/gta5/vehicles/police3.ytd": "dummy-police3-ytd",
    ...extra,
  });
  return file;
}

test("supported OPEN RPF7 fixture can be listed and read", () => {
  const dir = tmpDir("open-rpf-");
  const file = makeVehicleRpf(dir);
  const before = hashOfFile(file);
  const handle = archive.openArchive(file, { mode: "readOnly" });
  try {
    const entries = archive.listEntries(handle);
    assert.ok(entries.includes("x64/levels/gta5/vehicles/police3.yft"));
    assert.equal(archive.entryExists(handle, "x64/levels/gta5/vehicles/police3.ytd"), true);
    assert.equal(archive.readEntry(handle, "x64/levels/gta5/vehicles/police3.yft").toString("utf8"), "dummy-police3-yft");
    const meta = archive.getEntryMetadata(handle, "x64/levels/gta5/vehicles/police3.ytd");
    assert.equal(meta.exists, true);
    assert.equal(meta.name, "police3.ytd");
    assert.ok(meta.size > 0);
    archive.validate(handle);
  } finally {
    archive.close(handle);
  }
  assert.equal(hashOfFile(file), before);
  cleanup(dir);
});

test("invalid and unsupported RPF are rejected without mutation", () => {
  const dir = tmpDir("bad-rpf-");
  const invalid = path.join(dir, "broken.rpf");
  fs.writeFileSync(invalid, Buffer.from("NOT-A-REAL-RPF"));
  const beforeInvalid = hashOfFile(invalid);
  assert.throws(() => archive.openArchive(invalid), (err) => err.code === "INVALID_RPF");
  assert.equal(hashOfFile(invalid), beforeInvalid);

  const unsupported = path.join(dir, "rdr2.rpf");
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(0x52504638, 0);
  fs.writeFileSync(unsupported, buf);
  assert.throws(() => archive.openArchive(unsupported), (err) => err.code === "UNSUPPORTED_RPF_VERSION");

  const encrypted = path.join(dir, "encrypted.rpf");
  const enc = Buffer.alloc(16);
  enc.writeUInt32LE(RPF7_MAGIC, 0);
  enc.writeUInt32LE(2, 4);
  enc.writeUInt32LE(8, 8);
  enc.writeUInt32LE(ENC_NG, 12);
  fs.writeFileSync(encrypted, enc);
  const beforeEnc = hashOfFile(encrypted);
  assert.throws(() => archive.openArchive(encrypted), (err) => err.code === "ENCRYPTED_RPF_NOT_SUPPORTED");
  assert.equal(hashOfFile(encrypted), beforeEnc);
  cleanup(dir);
});

test("real backend mutations and capabilities stay read-only", () => {
  const dir = tmpDir("open-rpf-");
  const file = makeVehicleRpf(dir);
  const handle = archive.openArchive(file, { mode: "readOnly" });
  try {
    assert.throws(() => archive.addEntry(handle, "nope.bin", "x"), (err) => err.code === "NATIVE_RPF_WRITES_NOT_ENABLED");
    assert.throws(() => archive.replaceEntry(handle, "x64/levels/gta5/vehicles/police3.yft", "x"), (err) => err.code === "NATIVE_RPF_WRITES_NOT_ENABLED");
    assert.throws(() => archive.removeEntry(handle, "x64/levels/gta5/vehicles/police3.yft"), (err) => err.code === "NATIVE_RPF_WRITES_NOT_ENABLED");
    assert.throws(() => archive.commit(handle), (err) => err.code === "NATIVE_RPF_WRITES_NOT_ENABLED");
    assert.throws(() => archive.openArchive(file, { mode: "write" }), (err) => err.code === "NATIVE_RPF_WRITES_NOT_ENABLED");
  } finally {
    archive.close(handle);
  }
  const health = archive.getBackendHealth();
  assert.equal(health.available, true);
  assert.equal(health.mode, "READ_ONLY");
  assert.equal(health.realGtaArchives, true);
  assert.equal(health.writeEnabled, false);
  assert.equal(archive.ENABLE_NATIVE_ARCHIVE_WRITES, false);
  assert.equal(real.capabilities().write, false);
  cleanup(dir);
});

test("targeted discovery: complete group, missing _hi, ambiguous, and none", () => {
  const dir = tmpDir("disc-");
  const complete = makeVehicleRpf(dir);
  const other = path.join(dir, "other.rpf");
  writeOpenRpf7(other, {
    "dlc/vehicles/police3.yft": "other-police3",
  });
  const missingHi = path.join(dir, "partial.rpf");
  writeOpenRpf7(missingHi, {
    "x64/levels/gta5/vehicles/sheriff.yft": "s",
    "x64/levels/gta5/vehicles/sheriff.ytd": "t",
  });

  const high = findVehicleSlot("police3", { candidateArchives: [complete] });
  assert.equal(high.status, "DISCOVERED");
  assert.equal(high.confidence, "HIGH");

  const medium = findVehicleSlot("sheriff", { candidateArchives: [missingHi] });
  assert.equal(medium.status, "DISCOVERED");
  assert.equal(medium.confidence, "MEDIUM");

  const ambiguous = findVehicleSlot("police3", { candidateArchives: [complete, other] });
  assert.equal(ambiguous.status, "AMBIGUOUS");

  const none = findVehicleSlot("hydra", { candidateArchives: [complete] });
  assert.equal(none.status, "UNKNOWN");

  const names = findEntriesByName(["police3.yft"], [complete]);
  assert.equal(names.length, 1);
  cleanup(dir);
});

test("discovery cache reuses until archive or GTA build changes", () => {
  const dir = tmpDir("cache-rpf-");
  const dataDir = tmpDir("cache-data-");
  const file = makeVehicleRpf(dir);
  const first = discoverCached("police3", {
    candidateArchives: [file],
    dataDir,
    gtaBuild: "1.0.0",
  });
  assert.equal(first.fromCache, false);
  const second = discoverCached("police3", {
    candidateArchives: [file],
    dataDir,
    gtaBuild: "1.0.0",
  });
  assert.equal(second.fromCache, true);
  fs.appendFileSync(file, Buffer.from([0]));
  const changed = discoverCached("police3", {
    candidateArchives: [file],
    dataDir,
    gtaBuild: "1.0.0",
  });
  assert.equal(changed.fromCache, false);
  discoverCached("police3", { candidateArchives: [file], dataDir, gtaBuild: "1.0.0" });
  const build = discoverCached("police3", {
    candidateArchives: [file],
    dataDir,
    gtaBuild: "9.9.9",
  });
  assert.equal(build.fromCache, false);
  assert.equal(loadCache(dataDir).gtaBuild, "9.9.9");
  cleanup(dir, dataDir);
});

test("path resolver prefers VERIFIED mapping then DISCOVERED, never promotes to VERIFIED", () => {
  const dir = tmpDir("resolve-rpf-");
  const file = makeVehicleRpf(dir);
  const verified = resolveSlot("police3", {
    pathMap: {
      schemaVersion: 1,
      edition: "Enhanced",
      vehicleSlots: { police3: { archive: "vehicles.rpf", entryBase: "mapped", status: "VERIFIED" } },
    },
    discoverOptions: { candidateArchives: [file], dataDir: dir, gtaBuild: "1" },
  });
  assert.equal(verified.status, "VERIFIED");
  assert.equal(verified.entryBase, "mapped");

  const discovered = resolveSlot("police3", {
    pathMap: { schemaVersion: 1, edition: "Enhanced", vehicleSlots: {} },
    discoverOptions: { candidateArchives: [file], dataDir: dir, gtaBuild: "1" },
  });
  assert.equal(discovered.status, "DISCOVERED");
  assert.notEqual(discovered.status, "VERIFIED");
  cleanup(dir);
});

test("dry-run preview uses discovery and stays UNSUPPORTED", async () => {
  const dir = tmpDir("preview-rpf-");
  const file = makeVehicleRpf(dir);
  const pack = tmpDir("veh-pack-");
  writeFile(pack, "police3.yft", "m");
  writeFile(pack, "police3_hi.yft", "h");
  writeFile(pack, "police3.ytd", "t");
  const result = analyzeVehiclePackage(modScanner.scan(pack), {
    discoverOptions: { candidateArchives: [file], dataDir: dir, gtaBuild: "1.0.test" },
  });
  assert.equal(result.pathResolutions[0].status, "DISCOVERED");
  assert.match(result.preview.text, /READ-ONLY DISCOVERY/);
  assert.match(result.preview.text, /not enabled yet/);
  assert.equal(result.plan.capability, "UNSUPPORTED");
  assert.equal(result.plan.applied, false);

  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const preview = await smartInstall.analyze({
    source: pack,
    dutyPath: duty,
    dataDir,
    stagingRoot: tmpDir("staging-"),
    discoverOptions: { candidateArchives: [file], dataDir, gtaBuild: "1.0.test" },
  });
  assert.equal(preview.recommendation.status, "UNSUPPORTED");
  assert.equal(preview.archiveRequired, true);
  cleanup(dir, pack, duty, dataDir);
});
