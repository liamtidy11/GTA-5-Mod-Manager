const fs = require("fs");
const os = require("os");
const path = require("path");

// Shared helpers for Smart Install tests. Everything lives in throwaway temp
// dirs so tests NEVER touch the real Duty or Online folders.

function tmpDir(prefix = "smartinstall-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function readFile(root, rel) {
  return fs.readFileSync(path.join(root, rel.split("/").join(path.sep)), "utf8");
}

function fileExists(root, rel) {
  try {
    fs.accessSync(path.join(root, rel.split("/").join(path.sep)));
    return true;
  } catch {
    return false;
  }
}

// Minimal Duty folder that passes paths.isEnhancedFolder (has GTA5_Enhanced.exe).
function makeFakeDuty() {
  const duty = tmpDir("fake-duty-");
  fs.writeFileSync(path.join(duty, "GTA5_Enhanced.exe"), "stub-exe");
  fs.mkdirSync(path.join(duty, "plugins", "LSPDFR"), { recursive: true });
  return duty;
}

function cleanup(...dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

module.exports = { tmpDir, writeFile, readFile, fileExists, makeFakeDuty, cleanup };
