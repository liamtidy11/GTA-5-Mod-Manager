const fs = require("fs");
const path = require("path");

// Backs up the original Duty file before a Smart Install overwrites it, so an
// uninstall or a failed transaction can restore the exact previous bytes.
//
// Backups live under <dataDir>/backups/<modId>/<destRel>, mirroring the Duty
// layout. dataDir is kept outside the clean Online install.

function backupRoot(dataDir, modId) {
  return path.join(dataDir, "backups", modId);
}

function relOnDisk(destRel) {
  return String(destRel || "").replace(/\\/g, "/").split("/").join(path.sep);
}

// Copies absSrc (an existing Duty file) into the backup store for modId.
// Returns the destRel it was stored under (portable, forward-slashed).
function backupFile(dataDir, modId, destRel, absSrc) {
  const dest = path.join(backupRoot(dataDir, modId), relOnDisk(destRel));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(absSrc, dest);
  return String(destRel).replace(/\\/g, "/");
}

function hasBackup(dataDir, modId, destRel) {
  try {
    fs.accessSync(path.join(backupRoot(dataDir, modId), relOnDisk(destRel)));
    return true;
  } catch {
    return false;
  }
}

// Restores a previously backed-up file to absDest. Returns true on success.
function restore(dataDir, modId, destRel, absDest) {
  const src = path.join(backupRoot(dataDir, modId), relOnDisk(destRel));
  try {
    fs.accessSync(src);
  } catch {
    return false;
  }
  fs.mkdirSync(path.dirname(absDest), { recursive: true });
  fs.copyFileSync(src, absDest);
  return true;
}

function removeModBackups(dataDir, modId) {
  try {
    fs.rmSync(backupRoot(dataDir, modId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

module.exports = {
  backupRoot,
  backupFile,
  hasBackup,
  restore,
  removeModBackups,
};
