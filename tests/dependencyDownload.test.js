const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeFile, cleanup } = require("./helpers");
const dependencyDownload = require("../src/services/knowledge/dependencyDownload");
const smartInstall = require("../src/services/smartInstall");
const { makeFakeDuty } = require("./helpers");

function zipBuffer() {
  return Buffer.from("PK\u0003\u0004fake-zip");
}

test("curated catalog offers GitHub download for RageNativeUI and a page for DTF", () => {
  const offers = dependencyDownload.offersFor([
    { modId: "ragenativeui", name: "RAGENativeUI", kind: "REQUIRED", state: "MISSING" },
    { modId: "damage-tracker-framework", name: "Damage Tracker Framework", kind: "REQUIRED", state: "MISSING" },
    { modId: "scripthookvdotnet", name: "Script Hook V .NET", kind: "REQUIRED", state: "MISSING" },
  ]);
  const rnui = offers.find((o) => o.id === "ragenativeui");
  const dtf = offers.find((o) => o.id === "damage-tracker-framework");
  assert.ok(rnui && rnui.canDownload);
  assert.ok(rnui.pageUrl.startsWith("https://github.com/"));
  assert.ok(dtf && !dtf.canDownload);
  assert.ok(/lcpdfr\.com/i.test(dtf.pageUrl));
  assert.equal(offers.some((o) => o.id === "scripthookvdotnet"), false);
});

test("Script Hook V is never downloadable even by name", () => {
  assert.equal(dependencyDownload.isBlockedId("scripthookv"), true);
  assert.equal(dependencyDownload.offersForNames(["scripthookv", "Script Hook V .NET"]).length, 0);
});

test("download URLs must be official GitHub hosts over https", () => {
  assert.equal(
    dependencyDownload.isDownloadUrlAllowed(
      "https://github.com/alexguirre/RAGENativeUI/releases/download/1.9.3/RAGENativeUI.zip"
    ),
    true
  );
  assert.equal(dependencyDownload.isDownloadUrlAllowed("https://www.lcpdfr.com/downloads/file.zip"), false);
  assert.equal(dependencyDownload.isDownloadUrlAllowed("http://github.com/alexguirre/RAGENativeUI/x.zip"), false);
  assert.equal(dependencyDownload.isPageUrlAllowed("https://www.lcpdfr.com/downloads/gta5mods/scripts/42767-damage-tracker-framework/"), true);
});

test("GitHub asset lookup uses the catalog repo and rejects other hosts", async () => {
  const item = dependencyDownload.findItem("ragenativeui");
  const resolved = await dependencyDownload.resolveGithubAsset(item, async () => ({
    ok: true,
    json: async () => ({
      assets: [
        {
          name: "RAGENativeUI.zip",
          browser_download_url: "https://github.com/alexguirre/RAGENativeUI/releases/download/1.9.3/RAGENativeUI.zip",
          size: 100,
        },
        {
          name: "evil.zip",
          browser_download_url: "https://evil.example/malware.zip",
          size: 100,
        },
      ],
    }),
  }));
  assert.ok(resolved.url.includes("github.com/alexguirre/RAGENativeUI"));
});

test("download keeps only the expected support files", async () => {
  const dest = tmpDir("dep-dl-");
  const zipBytes = zipBuffer();
  try {
    const result = await dependencyDownload.downloadTo({
      modId: "lemonui",
      destDir: dest,
      fetchImpl: async (url) => {
        if (String(url).includes("api.github.com")) {
          return {
            ok: true,
            json: async () => ({
              assets: [
                {
                  name: "LemonUI.zip",
                  browser_download_url: "https://github.com/LemonUIbyLemon/LemonUI/releases/download/v2.2/LemonUI.zip",
                },
              ],
            }),
          };
        }
        return {
          ok: true,
          url,
          headers: { get: () => String(zipBytes.length) },
          arrayBuffer: async () => zipBytes,
        };
      },
      extractArchive: async (_archive, extracted) => {
        writeFile(extracted, "LemonUI.RagePluginHook/LemonUI.RagePluginHook.dll", "RPH");
        writeFile(extracted, "SHVDN/LemonUI.SHVDN3.dll", "NO");
        writeFile(extracted, "readme.txt", "skip");
      },
    });
    assert.ok(fs.existsSync(path.join(result.path, "LemonUI.RagePluginHook.dll")));
    assert.equal(fs.existsSync(path.join(result.path, "LemonUI.SHVDN3.dll")), false);
    assert.deepEqual(result.files, ["LemonUI.RagePluginHook.dll"]);
  } finally {
    cleanup(dest);
  }
});

test("Smart Install preview attaches download offers for Policing Redefined", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/PolicingRedefined.dll", "PR");
  try {
    const preview = await smartInstall.analyze({
      source: payload,
      dutyPath: duty,
      dataDir,
      stagingRoot: staging,
      lookupGuides: false,
    });
    const ids = (preview.downloadOffers || []).map((o) => o.id);
    assert.ok(ids.includes("ragenativeui"));
    assert.ok(ids.includes("damage-tracker-framework"));
    const rnui = preview.downloadOffers.find((o) => o.id === "ragenativeui");
    assert.equal(rnui.canDownload, true);
    const dtf = preview.downloadOffers.find((o) => o.id === "damage-tracker-framework");
    assert.equal(dtf.canDownload, false);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});
