const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { tmpDir, writeFile, makeFakeDuty, cleanup } = require("./helpers");
const versionDetector = require("../src/services/versionDetector");
const fileVersionReader = require("../src/services/fileVersionReader");
const inventory = require("../src/services/environmentInventory");
const manifestStore = require("../src/services/manifestStore");

const {
  normalizeVersion,
  compareVersions,
  satisfiesVersion,
  detectFileVersion,
  detectComponentVersion,
} = versionDetector;

beforeEach(() => {
  fileVersionReader.resetAdapter();
  fileVersionReader.clearCache();
  inventory.invalidate();
});

afterEach(() => {
  fileVersionReader.resetAdapter();
  fileVersionReader.clearCache();
});

test("normalizeVersion handles common forms and trailing zeros", () => {
  assert.equal(normalizeVersion("0.4.9").canonical, "0.4.9");
  assert.equal(normalizeVersion("0.4.9.0").canonical, "0.4.9");
  assert.equal(normalizeVersion("v1.2.3").canonical, "1.2.3");
  assert.equal(normalizeVersion("1.2.3-beta").canonical, "1.2.3-beta");
  assert.equal(normalizeVersion("1.2.3+build5").canonical, "1.2.3");
  assert.equal(normalizeVersion("1.2.3-beta+build5").canonical, "1.2.3-beta");
  assert.equal(normalizeVersion("UNKNOWN").unknown, true);
  assert.equal(normalizeVersion("not-a-version").unknown, true);
});

test("compareVersions uses numeric parts, not strings", () => {
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
  assert.equal(compareVersions("0.4.9", "0.4.9.0"), 0);
  assert.equal(compareVersions("1.2.3-beta", "1.2.3"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3-beta"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareVersions("UNKNOWN", "1.0"), null);
  assert.equal(compareVersions("???", "1.0"), null);
});

test("satisfiesVersion returns structured states", () => {
  assert.equal(satisfiesVersion("1.4.3", ">= 1.4.0").status, "SATISFIED");
  assert.equal(satisfiesVersion("1.4.3", "> 1.0").status, "SATISFIED");
  assert.equal(satisfiesVersion("2.5", "<= 2.5").status, "SATISFIED");
  assert.equal(satisfiesVersion("1.4.2", "= 1.4.2").status, "SATISFIED");
  assert.equal(satisfiesVersion("1.3.9", ">= 1.4.0").status, "TOO_OLD");
  assert.equal(satisfiesVersion("3.0", "<= 2.5").status, "TOO_NEW");
  assert.equal(satisfiesVersion("UNKNOWN", ">= 1.0").status, "UNKNOWN");
  assert.equal(satisfiesVersion("1.0", ">> 1.0").status, "INVALID_REQUIREMENT");
  assert.equal(satisfiesVersion("1.0", "banana").status, "INVALID_REQUIREMENT");
});

test("file metadata detection success and failure via adapter", () => {
  fileVersionReader.setAdapter((filePath) => {
    if (String(filePath).endsWith("good.dll")) {
      return { fileVersion: "1.4.2", productVersion: "1.4.2", productName: "Good", companyName: "Test", reason: "OK" };
    }
    return { fileVersion: null, productVersion: null, reason: "NOT_PE" };
  });
  const ok = detectFileVersion("C:\\mods\\good.dll");
  assert.equal(ok.version, "1.4.2");
  assert.equal(ok.versionSource, "FILE_METADATA");
  assert.equal(ok.versionConfidence, "HIGH");

  const bad = detectFileVersion("C:\\mods\\readme.txt");
  assert.equal(bad.version, "UNKNOWN");
  assert.equal(bad.versionSource, "NONE");
  assert.equal(bad.versionConfidence, "UNKNOWN");
});

test("missing file is UNKNOWN, not a throw", () => {
  const result = detectFileVersion("C:\\this\\file\\does-not-exist-tactix.dll");
  assert.equal(result.version, "UNKNOWN");
});

test("manifest fallback and metadata preferred over manifest", () => {
  fileVersionReader.setAdapter((filePath) => {
    if (String(filePath).includes("has-meta")) {
      return { productVersion: "2.0.0", fileVersion: "2.0.0.0", reason: "OK" };
    }
    return { reason: "NO_VERSION" };
  });

  const fromManifest = detectComponentVersion(
    { liveAbs: "C:\\duty\\none.dll", parkedAbs: [] },
    { manifestVersion: "1.5.0" }
  );
  assert.equal(fromManifest.version, "1.5.0");
  assert.equal(fromManifest.versionSource, "MANIFEST");
  assert.equal(fromManifest.versionConfidence, "HIGH");

  const fromFile = detectComponentVersion(
    { liveAbs: "C:\\duty\\has-meta.dll", parkedAbs: [] },
    { manifestVersion: "1.5.0" }
  );
  assert.equal(fromFile.version, "2.0.0");
  assert.equal(fromFile.versionSource, "FILE_METADATA");
});

test("parked component version uses parked file metadata", () => {
  fileVersionReader.setAdapter((filePath) => {
    if (String(filePath).includes("disabled")) {
      return { productVersion: "3.6.0", reason: "OK" };
    }
    return { reason: "MISSING" };
  });
  const detected = detectComponentVersion({
    liveAbs: "",
    parkedAbs: ["C:\\duty\\.tactix\\disabled\\shvdn\\ScriptHookVDotNet.asi"],
  });
  assert.equal(detected.version, "3.6.0");
  assert.equal(detected.versionSource, "FILE_METADATA");
});

test("version cache invalidates when size or mtime changes", () => {
  const dir = tmpDir("vercache-");
  const file = writeFile(dir, "plugin.dll", "AAAA");
  let hits = 0;
  fileVersionReader.setAdapter(() => {
    hits += 1;
    return { productVersion: "1.0.0", reason: "OK" };
  });
  try {
    const first = fileVersionReader.readFileVersion(file);
    const second = fileVersionReader.readFileVersion(file);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(hits, 1);

    fs.writeFileSync(file, "BBBBBB");
    const third = fileVersionReader.readFileVersion(file);
    assert.equal(third.cached, false);
    assert.equal(hits, 2);
  } finally {
    cleanup(dir);
  }
});

test("inventory exposes plugin and parked versions from metadata", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPD First Response.dll", "LSPDFR");
  writeFile(duty, "RagePluginHook.exe", "RPH");
  writeFile(duty, "plugins/LSPDFR/MyCallout.dll", "PLUGIN");
  writeFile(duty, ".tactix/disabled/shv/ScriptHookV.dll", "PARKED");
  fileVersionReader.setAdapter((filePath) => {
    const n = String(filePath).replace(/\\/g, "/").toLowerCase();
    if (n.endsWith("lspd first response.dll")) return { productVersion: "0.4.9", reason: "OK" };
    if (n.endsWith("ragepluginhook.exe")) return { productVersion: "1.109.0.0", reason: "OK" };
    if (n.endsWith("mycallout.dll")) return { productVersion: "1.4.2", reason: "OK" };
    if (n.endsWith("scripthookv.dll")) return { productVersion: "1.0.2802.0", reason: "OK" };
    return { reason: "NO_VERSION" };
  });
  try {
    const inv = inventory.getInventory({
      dutyPath: duty,
      deps: {
        overlayStatus: () => ({ nvidiaOverlay: false, nvidiaShare: false }),
        cortexRunning: () => false,
        readFileVersion: fileVersionReader.readFileVersion,
      },
    });
    assert.equal(inv.lspdfr.version, "0.4.9");
    assert.equal(inv.lspdfr.versionSource, "FILE_METADATA");
    assert.equal(inv.lspdfr.versionConfidence, "HIGH");
    assert.equal(inv.ragePluginHook.version, "1.109.0");
    const plugin = inv.plugins.find((p) => p.name === "MyCallout.dll");
    assert.equal(plugin.version, "1.4.2");
    const shv = inventory.findComponent(inv, "scripthookv");
    assert.equal(shv.state, "PARKED");
    assert.equal(shv.version, "1.0.2802");
    assert.equal(shv.versionSource, "FILE_METADATA");
    assert.equal(inv.gta.version, "UNKNOWN");
    assert.equal(inv.gta.versionSource, "NONE");
  } finally {
    cleanup(duty);
  }
});

test("inventory uses manifest version only when file metadata is absent", () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  writeFile(duty, "plugins/LSPDFR/RAGENativeUI.dll", "UI");
  manifestStore.write(dataDir, {
    id: "rnui",
    name: "RAGENativeUI",
    version: "1.9.2",
    enabled: true,
    files: [{ destination: "plugins/LSPDFR/RAGENativeUI.dll" }],
  });
  fileVersionReader.setAdapter(() => ({ reason: "NO_VERSION" }));
  try {
    const inv = inventory.getInventory({
      dutyPath: duty,
      dataDir,
      deps: {
        overlayStatus: () => ({ nvidiaOverlay: false, nvidiaShare: false }),
        cortexRunning: () => false,
        readFileVersion: fileVersionReader.readFileVersion,
      },
    });
    const fw = inv.frameworks.find((f) => f.id === "ragenativeui");
    assert.equal(fw.version, "1.9.2");
    assert.equal(fw.versionSource, "MANIFEST");
  } finally {
    cleanup(duty, dataDir);
  }
});
