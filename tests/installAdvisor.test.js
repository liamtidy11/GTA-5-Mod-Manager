const { test } = require("node:test");
const assert = require("node:assert");
const { tmpDir, writeFile, cleanup, makeFakeDuty } = require("./helpers");
const packInstructions = require("../src/services/knowledge/packInstructions");
const installAdvisor = require("../src/services/knowledge/installAdvisor");
const webGuideFetch = require("../src/services/knowledge/webGuideFetch");
const modScanner = require("../src/services/modScanner");
const smartInstall = require("../src/services/smartInstall");

test("pack README steps are extracted when they mention install", () => {
  const steps = packInstructions.extractSteps(`
    Policing Redefined
    1. Extract the zip.
    2. Drag the GTAV MAIN DIRECTORY files into your GTA V folder.
    3. Install RageNativeUI first.
    Visit https://policing-redefined.netlify.app/ for more.
  `);
  assert.ok(steps.some((step) => /drag|extract|ragenativeui/i.test(step)));
  assert.ok(packInstructions.urlsFromText("See https://policing-redefined.netlify.app/docs").length);
});

test("local guide matches Policing Redefined by archive name", () => {
  const guide = installAdvisor.matchGuide({ archiveName: "PolicingRedefined-1.0.0.4.zip", recognition: {} });
  assert.equal(guide && guide.id, "policing-redefined");
});

test("GTAV MAIN DIRECTORY wrapper is used as the payload root", () => {
  const root = tmpDir("pr-pack-");
  writeFile(root, "README.txt", "1. Drag the GTAV MAIN DIRECTORY into GTA V.");
  writeFile(root, "GTAV MAIN DIRECTORY/plugins/LSPDFR/PolicingRedefined.dll", "PR");
  try {
    const scan = modScanner.scan(root);
    assert.ok(scan.usableFiles.some((f) => f.rel.toLowerCase() === "plugins/lspdfr/policingredefined.dll"));
    assert.ok(/drag/i.test(scan.readmeText));
  } finally {
    cleanup(root);
  }
});

test("bang-prefixed GTAV MAIN DIRECTORY still maps config next to the plugin", () => {
  const root = tmpDir("pr-bang-");
  writeFile(root, "FOR DEVELOPERS ONLY/PolicingRedefined.xml", "<doc />");
  writeFile(root, "! GTAV MAIN DIRECTORY/plugins/LSPDFR/PolicingRedefined.dll", "PR");
  writeFile(root, "! GTAV MAIN DIRECTORY/plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml", "<regions />");
  try {
    const scan = modScanner.scan(root);
    const result = require("../src/services/modClassifier").classify(scan);
    const xml = result.perFile.find((f) => /defaultregions\.xml$/i.test(f.rel));
    const dll = result.perFile.find((f) => /policingredefined\.dll$/i.test(f.rel));
    assert.equal(dll.destination, "plugins/LSPDFR/PolicingRedefined.dll");
    assert.equal(xml.destination, "plugins/LSPDFR/PolicingRedefined/Backup/DefaultRegions.xml");
  } finally {
    cleanup(root);
  }
});

test("analyze attaches Policing Redefined install steps without going online", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/PolicingRedefined.dll", "PR");
  writeFile(payload, "README.txt", "1. Install RageNativeUI before going on duty.");
  try {
    const preview = await smartInstall.analyze({
      source: payload,
      dutyPath: duty,
      dataDir,
      stagingRoot: staging,
      lookupGuides: false,
    });
    assert.equal(preview.canonicalModId, "policing-redefined");
    assert.ok(preview.installGuide);
    assert.ok(preview.installGuide.steps.length);
    assert.equal(preview.installGuide.lookedOnline, false);
    assert.ok(preview.installGuide.steps.some((step) => /duty|plugins\\lspdfr|ragenativeui/i.test(step)));
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("web lookup only allows known https hosts", () => {
  assert.equal(webGuideFetch.allowedUrl("https://policing-redefined.netlify.app/"), true);
  assert.equal(webGuideFetch.allowedUrl("https://evil.example/malware"), false);
  assert.equal(webGuideFetch.allowedUrl("http://www.lcpdfr.com/"), false);
});

test("advisor can merge pack steps with a mocked public page", async () => {
  const scan = {
    readmeText: "1. Copy the plugin into Plugins\\LSPDFR.",
    usableFiles: [],
    files: [],
    root: "",
  };
  const guide = await installAdvisor.advise({
    scan,
    recognition: { modId: "policing-redefined", name: "Policing Redefined" },
    archiveName: "PolicingRedefined.zip",
    lookup: true,
    fetchPages: async () => [{ url: "https://policing-redefined.netlify.app/", steps: ["Go on duty once to create settings."] }],
    summarize: async () => [],
  });
  assert.equal(guide.matchedId, "policing-redefined");
  assert.equal(guide.lookedOnline, true);
  assert.ok(guide.steps.some((step) => /duty/i.test(step)));
});
