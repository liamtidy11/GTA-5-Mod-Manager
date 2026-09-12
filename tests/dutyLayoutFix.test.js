const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { tmpDir, writeFile, fileExists, makeFakeDuty, cleanup } = require("./helpers");
const { normalizeDutyDest, destNeedsNormalize } = require("../src/services/knowledge/gameTreeNormalize");
const dutyLayoutFix = require("../src/services/knowledge/dutyLayoutFix");
const smartInstall = require("../src/services/smartInstall");
const manifestStore = require("../src/services/manifestStore");

test("wrapper prefixes are stripped from Duty destinations", () => {
  assert.equal(
    normalizeDutyDest("! GTAV MAIN DIRECTORY/plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml"),
    "plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml"
  );
  assert.equal(destNeedsNormalize("plugins/LSPDFR/PolicingRedefined.dll"), false);
});

test("heal copies a misplaced wrapper tree into plugins/LSPDFR", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "! GTAV MAIN DIRECTORY/plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml", "<regions />");
  writeFile(duty, "plugins/LSPDFR/PolicingRedefined.dll", "PR");
  try {
    const result = dutyLayoutFix.healDutyLayout({ dutyPath: duty, dataDir: tmpDir("data-") });
    assert.ok(result.moved.includes("plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml"));
    assert.equal(fileExists(duty, "plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml"), true);
  } finally {
    cleanup(duty);
  }
});

test("heal restores required PR data from the stored pack", () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  writeFile(duty, "plugins/LSPDFR/PolicingRedefined.dll", "PR");
  const storeXml =
    "! GTAV MAIN DIRECTORY/plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml";
  writeFile(path.join(dataDir, "store", "pr-pack"), storeXml, "<regions />");
  manifestStore.write(dataDir, {
    schemaVersion: 1,
    id: "pr-pack",
    name: "Policing Redefined",
    files: [{ destination: storeXml, action: "add", hash: "", backup: null }],
  });
  try {
    const result = dutyLayoutFix.healDutyLayout({ dutyPath: duty, dataDir });
    assert.ok(result.repaired.includes("plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml") || result.restored.includes("plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml"));
    assert.equal(fileExists(duty, "plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml"), true);
    const next = manifestStore.read(dataDir, "pr-pack");
    assert.equal(next.files[0].destination, "plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml");
  } finally {
    cleanup(duty, dataDir);
  }
});

test("commit writes wrapper destinations into the real plugin folder", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/PolicingRedefined.dll", "PR");
  writeFile(payload, "plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml", "<regions />");
  try {
    const preview = await smartInstall.analyze({
      source: payload,
      dutyPath: duty,
      dataDir,
      stagingRoot: staging,
      lookupGuides: false,
    });
    preview.files = preview.files.map((file) => ({
      ...file,
      destination: file.destination.includes("DefaultRegions")
        ? `! GTAV MAIN DIRECTORY/${file.destination}`
        : file.destination,
    }));
    await smartInstall.commit({ preview, dutyPath: duty, dataDir });
    assert.equal(fileExists(duty, "plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml"), true);
    assert.equal(fileExists(duty, "! GTAV MAIN DIRECTORY/plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml"), false);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});
