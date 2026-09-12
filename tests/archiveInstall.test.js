const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sevenBin = require("7zip-bin");
const { tmpDir, writeFile, fileExists, makeFakeDuty, cleanup } = require("./helpers");
const smartInstall = require("../src/services/smartInstall");

// Exercises the REAL extraction path (7-Zip), which the folder-based tests
// cannot. Skips gracefully if no 7-Zip binary is available on this machine.

function sevenZipBin() {
  const local = path.join(__dirname, "..", "tools", "7z", "7z.exe");
  return fs.existsSync(local) ? local : sevenBin.path7za;
}

const hasSevenZip = (() => {
  try {
    return fs.existsSync(sevenZipBin());
  } catch {
    return false;
  }
})();

const skip = hasSevenZip ? false : "7-Zip binary unavailable";

test("a real .zip archive installs and uninstalls cleanly", { skip }, async () => {
  const payload = tmpDir("payload-");
  writeFile(payload, "MyCallout/plugins/LSPDFR/MyCallout.dll", "CALLOUT-DLL");
  writeFile(payload, "MyCallout/RAGENativeUI.dll", "DEP");
  writeFile(payload, "MyCallout/install.bat", "@echo must never run\n");
  writeFile(payload, "MyCallout/readme.txt", "junk");

  const archives = tmpDir("arch-");
  const zip = path.join(archives, "MyCallout.zip");
  execFileSync(sevenZipBin(), ["a", "-tzip", zip, path.join(payload, "MyCallout")], { stdio: "ignore" });

  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  try {
    const preview = await smartInstall.analyze({ source: zip, dutyPath: duty, dataDir, stagingRoot: staging });

    const dll = preview.files.find((f) => f.destination.endsWith("MyCallout.dll"));
    assert.equal(dll.destination, "plugins/LSPDFR/MyCallout.dll");

    const bat = preview.files.find((f) => f.source.endsWith("install.bat"));
    assert.equal(bat.action, "skip", "executables must be skipped");
    assert.ok(preview.executables.some((e) => e.endsWith("install.bat")), "executables must be surfaced");
    assert.equal(preview.files.some((f) => f.source.endsWith("readme.txt")), false, "junk excluded");

    const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
    assert.equal(fileExists(duty, "plugins/LSPDFR/MyCallout.dll"), true);
    assert.equal(fileExists(duty, "plugins/LSPDFR/RAGENativeUI.dll"), true);
    assert.equal(fileExists(duty, "install.bat"), false, "executable must not be written to Duty");

    await smartInstall.uninstall({ modId: manifest.id, dutyPath: duty, dataDir });
    assert.equal(fileExists(duty, "plugins/LSPDFR/MyCallout.dll"), false);
    assert.equal(smartInstall.list(dataDir).length, 0);
  } finally {
    cleanup(payload, archives, duty, dataDir, staging);
  }
});
