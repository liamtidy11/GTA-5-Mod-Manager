const fs = require("fs");
const path = require("path");
const { exists } = require("./paths");

function storeRoot(dataDir, installId) {
  return path.join(dataDir, "store", installId);
}

function storeRel(destRel) {
  return String(destRel || "").replace(/\\/g, "/").split("/").join(path.sep);
}

function saveInstalledFile(dataDir, installId, destRel, absSrc) {
  const dest = path.join(storeRoot(dataDir, installId), storeRel(destRel));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(absSrc, dest);
}

function hasStoredFile(dataDir, installId, destRel) {
  try {
    fs.accessSync(path.join(storeRoot(dataDir, installId), storeRel(destRel)));
    return true;
  } catch {
    return false;
  }
}

function restoreStoredFile(dataDir, installId, destRel, absDest) {
  const src = path.join(storeRoot(dataDir, installId), storeRel(destRel));
  if (!exists(src)) return false;
  fs.mkdirSync(path.dirname(absDest), { recursive: true });
  fs.copyFileSync(src, absDest);
  return true;
}

function removeStore(dataDir, installId) {
  try {
    fs.rmSync(storeRoot(dataDir, installId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

module.exports = { storeRoot, saveInstalledFile, hasStoredFile, restoreStoredFile, removeStore };
