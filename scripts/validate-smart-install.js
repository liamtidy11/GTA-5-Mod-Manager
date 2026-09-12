// Real-archive end-to-end validation for Smart Install v1.
// Builds actual .zip and .7z archives with the same 7-Zip binary the app uses,
// then runs the true pipeline (extract -> scan -> classify -> preview ->
// transactional install -> uninstall) against a throwaway fake Duty folder.
// Never touches the real Duty/Online folders. Exits non-zero on any failure.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const sevenBin = require("7zip-bin");
const smartInstall = require("../src/services/smartInstall");

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log(`  OK    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
}

function sevenZipBin() {
  const local = path.join(__dirname, "..", "tools", "7z", "7z.exe");
  return fs.existsSync(local) ? local : sevenBin.path7za;
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function w(root, rel, content) {
  const abs = path.join(root, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function present(root, rel) {
  try {
    fs.accessSync(path.join(root, rel.split("/").join(path.sep)));
    return true;
  } catch {
    return false;
  }
}

function makeFakeDuty() {
  const duty = tmp("fake-duty-");
  fs.writeFileSync(path.join(duty, "GTA5_Enhanced.exe"), "stub-exe");
  fs.mkdirSync(path.join(duty, "plugins", "LSPDFR"), { recursive: true });
  return duty;
}

// Build a realistic LSPDFR callout pack, including a dependency DLL at the root
// and an installer .bat that must be surfaced but never installed or run.
function buildPayload() {
  const payload = tmp("smart-payload-");
  w(payload, "MyCallout/plugins/LSPDFR/MyCallout.dll", "CALLOUT-DLL-BODY-v1");
  w(payload, "MyCallout/plugins/LSPDFR/MyCallout.ini", "[Settings]\nEnabled=true\n");
  w(payload, "MyCallout/RAGENativeUI.dll", "RAGENATIVEUI-BODY");
  w(payload, "MyCallout/README.txt", "Drop into plugins/LSPDFR. Requires RAGENativeUI.");
  w(payload, "MyCallout/install.bat", "@echo this must never run\n");
  return { payload, folder: path.join(payload, "MyCallout") };
}

function makeArchive(folder, outFile, type) {
  execFileSync(sevenZipBin(), ["a", type, outFile, folder], { stdio: "ignore" });
  return outFile;
}

async function runForArchive(archive) {
  console.log(`\nArchive: ${path.basename(archive)}`);
  const duty = makeFakeDuty();
  const dataDir = tmp("data-");
  const staging = tmp("staging-");

  // --- analyze (real extraction) ---
  const preview = await smartInstall.analyze({
    source: archive,
    dutyPath: duty,
    dataDir,
    stagingRoot: staging,
  });

  const dll = preview.files.find((f) => f.destination.endsWith("MyCallout.dll"));
  const ini = preview.files.find((f) => f.destination.endsWith("MyCallout.ini"));
  const dep = preview.files.find((f) => f.source.endsWith("RAGENativeUI.dll"));
  const bat = preview.files.find((f) => f.source.endsWith("install.bat"));

  check(Boolean(dll) && dll.destination === "plugins/LSPDFR/MyCallout.dll", "callout DLL maps to plugins/LSPDFR");
  check(Boolean(ini) && ini.destination === "plugins/LSPDFR/MyCallout.ini", "callout INI maps to plugins/LSPDFR");
  check(Boolean(dep) && dep.category === "DEPENDENCY", "RAGENativeUI is classified as a dependency");
  check(Boolean(bat) && bat.action === "skip", "install.bat is skipped (not installed)");
  check(preview.executables.some((e) => e.endsWith("install.bat")), "install.bat is surfaced as an executable");
  check(!preview.files.some((f) => f.source.endsWith("README.txt")), "README is treated as junk (not in plan)");

  // --- commit (transactional install) ---
  const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
  check(present(duty, "plugins/LSPDFR/MyCallout.dll"), "DLL installed into Duty");
  check(present(duty, "plugins/LSPDFR/MyCallout.ini"), "INI installed into Duty");
  check(present(duty, "plugins/LSPDFR/RAGENativeUI.dll"), "dependency DLL installed into Duty");
  check(!present(duty, "install.bat"), "install.bat was NOT written to Duty");
  check(manifest.files.length === 3, `manifest records 3 installed files (got ${manifest.files.length})`);
  check(manifest.files.every((f) => f.hash && f.hash.length === 64), "every installed file has a sha-256 hash");

  // --- uninstall (rollback to prior state) ---
  await smartInstall.uninstall({ modId: manifest.id, dutyPath: duty, dataDir });
  check(!present(duty, "plugins/LSPDFR/MyCallout.dll"), "DLL removed on uninstall");
  check(!present(duty, "plugins/LSPDFR/RAGENativeUI.dll"), "dependency removed on uninstall");
  check(smartInstall.list(dataDir).length === 0, "manifest cleared after uninstall");

  fs.rmSync(duty, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
}

async function main() {
  console.log("Smart Install v1 — real-archive validation");
  console.log(`7-Zip: ${sevenZipBin()}`);

  const { payload, folder } = buildPayload();
  const archivesDir = tmp("smart-arch-");
  const zip = makeArchive(folder, path.join(archivesDir, "MyCallout.zip"), "-tzip");
  const sevenz = makeArchive(folder, path.join(archivesDir, "MyCallout.7z"), "-t7z");

  await runForArchive(zip);
  await runForArchive(sevenz);

  fs.rmSync(payload, { recursive: true, force: true });
  fs.rmSync(archivesDir, { recursive: true, force: true });

  console.log("");
  if (failures) {
    console.log(`Validation FAILED: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("Validation PASSED: real .zip and .7z install/uninstall cleanly.");
}

main().catch((error) => {
  console.error(`Validation crashed: ${error.stack || error.message}`);
  process.exit(1);
});
